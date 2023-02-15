import type { FileCapabilities, VirtualFile } from '@volar/language-core';
import * as vscode from 'vscode-languageserver-protocol';
import { TextDocument } from 'vscode-languageserver-textdocument';
import type { LanguageServicePluginContext } from '../types';
import * as shared from '@volar/shared';
import { SourceMap } from '@volar/source-map';
import { stringToSnapshot } from '../utils/common';

export function register(context: LanguageServicePluginContext) {

	return async (
		uri: string,
		options: vscode.FormattingOptions,
		range?: vscode.Range,
		onTypeParams?: {
			ch: string,
			position: vscode.Position,
		},
	) => {

		let document = context.getTextDocument(uri);
		if (!document) return;

		range ??= vscode.Range.create(document.positionAt(0), document.positionAt(document.getText().length));

		const source = context.documents.getSourceByUri(document.uri);
		if (!source) {
			return onTypeParams
				? await tryFormat(document, onTypeParams.position, onTypeParams.ch)
				: await tryFormat(document, range, undefined);
		}

		const initialIndentLanguageId = await context.env.configurationHost?.getConfiguration<Record<string, boolean>>('volar.format.initialIndent') ?? { html: true };
		const originalSnapshot = source.snapshot;
		const rootVirtualFile = source.root;
		const originalDocument = document;

		let level = 0;
		let edited = false;

		while (true) {

			const embeddedFiles = getEmbeddedFilesByLevel(rootVirtualFile, level++);
			if (embeddedFiles.length === 0)
				break;

			let edits: vscode.TextEdit[] = [];
			const toPatchIndentUris: string[] = [];

			for (const embedded of embeddedFiles) {

				if (!embedded.capabilities.documentFormatting)
					continue;

				const maps = [...context.documents.getMapsByVirtualFileName(embedded.fileName)];
				const map = maps.find(map => map[1].sourceFileDocument.uri === document!.uri)?.[1];
				if (!map)
					continue;

				let virtualCodeEdits: vscode.TextEdit[] | undefined;

				if (onTypeParams) {

					const embeddedPosition = map.toGeneratedPosition(onTypeParams.position);

					if (embeddedPosition) {
						virtualCodeEdits = await tryFormat(
							map.virtualFileDocument,
							embeddedPosition,
							onTypeParams.ch,
						);
					}
				}
				else {

					let virtualCodeRange = map.toGeneratedRange(range);

					if (!virtualCodeRange) {
						const firstMapping = map.map.mappings.sort((a, b) => a.sourceRange[0] - b.sourceRange[0])[0];
						const lastMapping = map.map.mappings.sort((a, b) => b.sourceRange[0] - a.sourceRange[0])[0];
						if (
							firstMapping && document.offsetAt(range.start) < firstMapping.sourceRange[0]
							&& lastMapping && document.offsetAt(range.end) > lastMapping.sourceRange[1]
						) {
							virtualCodeRange = {
								start: map.virtualFileDocument.positionAt(firstMapping.generatedRange[0]),
								end: map.virtualFileDocument.positionAt(lastMapping.generatedRange[1]),
							};
						}
					}

					if (virtualCodeRange) {
						virtualCodeEdits = await tryFormat(map.virtualFileDocument, virtualCodeRange);
					}

					if (virtualCodeEdits) {
						toPatchIndentUris.push(map.virtualFileDocument.uri);
					}
				}

				if (!virtualCodeEdits)
					continue;

				for (const textEdit of virtualCodeEdits) {
					const range = map.toSourceRange(textEdit.range);
					if (range) {
						edits.push({
							newText: textEdit.newText,
							range,
						});
					}
				}
			}

			if (edits.length > 0) {
				const newText = TextDocument.applyEdits(document, edits);
				document = TextDocument.create(document.uri, document.languageId, document.version + 1, newText);
				context.core.virtualFiles.updateSource(shared.uriToFileName(document.uri), stringToSnapshot(document.getText()), undefined);
				edited = true;
			}

			if (level > 1) {

				const baseIndent = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';

				for (const toPatchIndentUri of toPatchIndentUris) {

					for (const [file, map] of context.documents.getMapsByVirtualFileUri(toPatchIndentUri)) {

						const indentEdits = patchInterpolationIndent(
							document,
							map.map,
							initialIndentLanguageId[map.virtualFileDocument.languageId] ? baseIndent : '',
							file.capabilities.documentFormatting,
						);

						if (indentEdits.length > 0) {
							const newText = TextDocument.applyEdits(document, indentEdits);
							document = TextDocument.create(document.uri, document.languageId, document.version + 1, newText);
							context.core.virtualFiles.updateSource(shared.uriToFileName(document.uri), stringToSnapshot(document.getText()), undefined);
							edited = true;
						}
					}
				}
			}
		}

		if (edited) {
			// recover
			context.core.virtualFiles.updateSource(shared.uriToFileName(document.uri), originalSnapshot, undefined);
		}

		if (document.getText() === originalDocument.getText())
			return;

		const editRange = vscode.Range.create(
			originalDocument.positionAt(0),
			originalDocument.positionAt(originalDocument.getText().length),
		);
		const textEdit = vscode.TextEdit.replace(editRange, document.getText());

		return [textEdit];

		function getEmbeddedFilesByLevel(rootFile: VirtualFile, level: number) {

			const embeddedFilesByLevel: VirtualFile[][] = [[rootFile]];

			while (true) {

				if (embeddedFilesByLevel.length > level)
					return embeddedFilesByLevel[level];

				let nextLevel: VirtualFile[] = [];

				for (const file of embeddedFilesByLevel[embeddedFilesByLevel.length - 1]) {

					nextLevel = nextLevel.concat(file.embeddedFiles);
				}

				embeddedFilesByLevel.push(nextLevel);
			}
		}

		async function tryFormat(
			document: TextDocument,
			range: vscode.Range | vscode.Position,
			ch?: string,
		) {

			let formatRange = range;

			for (const plugin of Object.values(context.plugins)) {

				let edits: vscode.TextEdit[] | null | undefined;

				try {
					if (ch !== undefined && vscode.Position.is(formatRange)) {
						edits = await plugin.formatOnType?.(document, formatRange, ch, options);
					}
					else if (ch === undefined && vscode.Range.is(formatRange)) {
						edits = await plugin.format?.(document, formatRange, options);
					}
				}
				catch (err) {
					console.warn(err);
				}

				if (!edits)
					continue;

				return edits;
			}
		}
	};
}

function patchInterpolationIndent(document: TextDocument, map: SourceMap, initialIndent: string, data: FileCapabilities['documentFormatting']) {

	const insertFirstNewline = typeof data === 'object' ? data.insertFirstNewline : false;
	const insertFinalNewline = typeof data === 'object' ? data.insertFinalNewline : false;
	const indentTextEdits: vscode.TextEdit[] = [];

	for (let i = 0; i < map.mappings.length; i++) {

		const mapping = map.mappings[i];
		const firstLineIndent = getBaseIndent(mapping.sourceRange[0]);
		const oldText = document.getText().substring(mapping.sourceRange[0], mapping.sourceRange[1]);
		if (oldText.indexOf('\n') === -1) {
			continue;
		}

		let newText = oldText;

		if (insertFirstNewline && i === 0 && !newText.startsWith('\n')) {
			newText = '\n' + newText;
		}
		if (insertFinalNewline && i === map.mappings.length - 1 && !newText.endsWith('\n')) {
			newText = newText + '\n';
		}

		const lines = newText.split('\n');
		for (let i = 1; i < lines.length - 1; i++) {
			if (lines[i] !== '') {
				lines[i] = firstLineIndent + initialIndent + lines[i];
			}
		}
		lines[lines.length - 1] = firstLineIndent + lines[lines.length - 1];

		newText = lines.join('\n');

		if (newText !== oldText) {
			indentTextEdits.push({
				newText,
				range: {
					start: document.positionAt(mapping.sourceRange[0]),
					end: document.positionAt(mapping.sourceRange[1]),
				},
			});
		}
	}

	return indentTextEdits;

	function getBaseIndent(pos: number) {
		const startPos = document.positionAt(pos);
		const startLineText = document.getText({ start: { line: startPos.line, character: 0 }, end: startPos });
		return startLineText.substring(0, startLineText.length - startLineText.trimStart().length);
	}
}
