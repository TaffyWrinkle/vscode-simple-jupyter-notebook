/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import * as vscode from 'vscode';
import { KernelManager } from './kernelManager';
import { KernelProvider, LocationType } from './kernelProvider';
import { NotebookKernel } from './notebookKernel';
import { XeusDebugAdapter } from './xeusDebugAdapter';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  const kernelManager = new KernelManager(
    new KernelProvider(() => [
      ...vscode.workspace
        .getConfiguration('simple-jupyter')
        .get('searchPaths', [])
        .map(path => ({ path, type: LocationType.User })),
      ...KernelProvider.defaultSearchPaths(),
    ]),
    context,
  );

  context.subscriptions.push(
    vscode.notebook.registerNotebookKernel(
      'simple-jupyter-kernel',
      ['*'],
      new NotebookKernel(kernelManager),
    ),
    vscode.commands.registerCommand('simple-jupyter-notebook.change-kernel', () =>
      kernelManager.changeActive(),
    ),
    vscode.commands.registerCommand('simple-jupyter-notebook.restart-kernel', () =>
      kernelManager.closeAllKernels(),
    ),
  );

  context.subscriptions.push(

    vscode.debug.registerDebugAdapterDescriptorFactory('xeus', {
      createDebugAdapterDescriptor: async session => {
        const kernel = await kernelManager.getDocumentKernelByUri(session.configuration.__document);
        const notebookDocument = kernelManager.getDocumentByUri(session.configuration.__document);
        if (kernel && notebookDocument) {
          return new vscode.DebugAdapterInlineImplementation(new XeusDebugAdapter(session, notebookDocument, kernel));
        }
        vscode.window.showErrorMessage('Kernel appears to have been stopped');
        return;
      }
    }),

    vscode.commands.registerCommand('simple-jupyter-notebook.toggleDebugging', async () => {
      const doc = vscode.notebook.activeNotebookDocument;
      if (!doc) {
        vscode.window.showErrorMessage('No active notebook document to debug');
        return;
      }

      const kernel = await kernelManager.getDocumentKernel(doc); // ensure the kernel is running
      if (!kernel) {
        vscode.window.showErrorMessage('Kernel appears to have been stopped');
        return;
      }

      kernel.isDebugging = !kernel.isDebugging;

      for (let cell of doc.cells) {
        if (cell.cellKind === vscode.CellKind.Code) {
          cell.metadata.breakpointMargin = kernel.isDebugging;
        }
      }

      if (kernel.isDebugging) {
        await vscode.debug.startDebugging(undefined, {
          type: 'xeus',
          name: 'xeus debugging',
          request: 'attach',
          __document: doc.uri.toString(),
        });
      } else {
        await vscode.commands.executeCommand('workbench.action.debug.stop');
      }
    })
  );
}

// this method is called when your extension is deactivated
export function deactivate() {
  // no-op
}
