/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import * as vscode from 'vscode';
import { KernelManager } from './kernelManager';
import { DebugProtocol } from 'vscode-debugprotocol';
import { IRunningKernel } from './kernelProvider';
import { debugRequest, debugResponse, MessageType, JupyterMessage, DebugMessage } from './messaging';
import { filter, tap } from 'rxjs/operators';
import { Subscription } from 'rxjs';
import * as path from 'path';

/**
 * The DebuggingManager maintains the mapping between notebook documents and debug sessions.
 */
export class DebuggingManager {

  private notebookToDebugger = new Map<vscode.NotebookDocument, Debugger>();

  public constructor(
    context: vscode.ExtensionContext,
    private kernelManager: KernelManager
  ) {

    vscode.debug.breakpoints;   // start to fetch breakpoints

    context.subscriptions.push(

      // track termination of debug sessions
      vscode.debug.onDidTerminateDebugSession(async session => {
        for (const [doc, dbg] of this.notebookToDebugger.entries()) {
          if (dbg && session === await dbg.session) {
            this.notebookToDebugger.delete(doc);
            this.updateDebuggerUI(doc, false);
            break;
          }
        }
      }),

      // track closing of notebooks documents
      vscode.notebook.onDidCloseNotebookDocument(async document => {
        const dbg = this.notebookToDebugger.get(document);
        if (dbg) {
          await dbg.stop();
        }
        this.fixBreakpoints(document);
      }),

      // factory for xeus debug adapters
      vscode.debug.registerDebugAdapterDescriptorFactory('xeus', {
        createDebugAdapterDescriptor: async session => {
          const dbg = this.getDebuggerByUri(session.configuration.__document);
          if (dbg) {
            const kernel = await this.kernelManager.getDocumentKernel(dbg.document);
            if (kernel) {
              dbg.resolve(session);
              return new vscode.DebugAdapterInlineImplementation(new XeusDebugAdapter(session, dbg.document, kernel));
            } else {
              dbg.reject(new Error('Kernel appears to have been stopped'));
            }
          }
          // should not happen
          return;
        }
      })
    );
  }

  private fixBreakpoints(doc: vscode.NotebookDocument) {

    const map = new Map<string, vscode.Uri>();

    doc.cells.forEach((cell, ix) => {
      const pos = parseInt(cell.uri.fragment);
      if (pos !== ix) {
        map.set(cell.uri.toString(), cell.uri.with({ fragment: ix.toString().padStart(8, '0') }));
      }
    });

    if (map.size > 0) {
      const addBpts: vscode.SourceBreakpoint[] = [];
      const removeBpt: vscode.SourceBreakpoint[] = [];
      for (let b of vscode.debug.breakpoints) {
        if (b instanceof vscode.SourceBreakpoint) {
          const s = map.get(b.location.uri.toString());
          if (s) {
            removeBpt.push(b);
            const loc = new vscode.Location(s, b.location.range);
            addBpts.push(new vscode.SourceBreakpoint(loc /*, b.enabled, b.condition, b.hitCondition, b.logMessage*/));
          }
        }
      }
      if (removeBpt.length > 0) {
        vscode.debug.removeBreakpoints(removeBpt);
      }
      if (addBpts.length > 0) {
        vscode.debug.addBreakpoints(addBpts);
      }
    }

  }

  public async toggleDebugging(doc: vscode.NotebookDocument) {

    let showBreakpointMargin = false;
    let dbg = this.notebookToDebugger.get(doc);
    if (dbg) {
      await dbg.stop();
    } else {
      dbg = new Debugger(doc);
      this.notebookToDebugger.set(doc, dbg);
      await this.kernelManager.getDocumentKernel(doc); // ensure the kernel is running
      try {
        await dbg.session;
        showBreakpointMargin = true;
      } catch (err) {
        vscode.window.showErrorMessage(`Can't start debugging (${err})`);
      }
      this.updateDebuggerUI(doc, showBreakpointMargin);
    }
  }

  //---- private

  private getDebuggerByUri(docUri: string): Debugger | undefined {
    for (const [doc, dbg] of this.notebookToDebugger.entries()) {
      if (docUri === doc.uri.toString()) {
        return dbg;
      }
    }
    return undefined;
  }

  private updateDebuggerUI(doc: vscode.NotebookDocument, showBreakpointsMargin: boolean) {
    for (let cell of doc.cells) {
      if (cell.cellKind === vscode.CellKind.Code) {
        cell.metadata.breakpointMargin = showBreakpointsMargin;
      }
    }
  }
}

class Debugger {

  private resolveFunc?: (value: vscode.DebugSession) => void;
  private rejectFunc?: (reason?: any) => void;

  readonly session: Promise<vscode.DebugSession>;

  constructor(public readonly document: vscode.NotebookDocument) {
    this.session = new Promise<vscode.DebugSession>((resolve, reject) => {

      this.resolveFunc = resolve;
      this.rejectFunc = reject;

      vscode.debug.startDebugging(undefined, {
        type: 'xeus',
        name: `${path.basename(document.fileName)}`,
        request: 'attach',
        __document: document.uri.toString(),
      }).then(undefined, reject);
    });
  }

  resolve(session: vscode.DebugSession) {
    if (this.resolveFunc) {
      this.resolveFunc(session);
    }
  }

  reject(reason: any) {
    if (this.rejectFunc) {
      this.rejectFunc(reason);
    }
  }

  async stop() {
    if (vscode.debug.activeDebugSession === await this.session) {
      return vscode.commands.executeCommand('workbench.action.debug.stop');
    } else {
      console.log('cannot stop debugger');
    }
  }
}


//---- debug adapter for Jupyter debug protocol

const debugEvents: ReadonlySet<MessageType> = new Set([
  'debug_request',
  'debug_reply',
  'debug_event',
]);

const isDebugMessage = (msg: JupyterMessage): msg is DebugMessage =>
  debugEvents.has(msg.header.msg_type);

/**
 * the XeusDebugAdapter delegates the DAP protocol to the xeus kernel
 * via Jupyter's experimental debug_request, debug_reply, debug_event messages.
 */
class XeusDebugAdapter implements vscode.DebugAdapter {

  private readonly fileToCell = new Map<string, vscode.NotebookCell>();
  private readonly cellToFile = new Map<string, string>();
  private readonly sendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  private readonly messageListener: Subscription;

  onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage> = this.sendMessage.event;

  constructor(
    private session: vscode.DebugSession,
    private notebookDocument: vscode.NotebookDocument,
    private readonly kernel: IRunningKernel
  ) {
    this.messageListener = this.kernel.connection.messages
      .pipe(
        filter(isDebugMessage),
        //tap(msg => console.log('<- recv', msg.content)),
      )
      .subscribe(evt => {

        // map Sources from Xeus to VS Code
        visitSources(evt.content, source => {
          if (source && source.path) {
            const cell = this.fileToCell.get(source.path);
            if (cell) {
              source.name = path.basename(cell.uri.path);
              const cellIndex = cell.notebook.cells.indexOf(cell);
              if (cellIndex >= 0) {
                source.name += `, Cell ${cellIndex + 1}`;
              }
              source.path = cell.uri.toString();
            }
          }
        });

        this.sendMessage.fire(evt.content);
      });
  }

  async handleMessage(message: DebugProtocol.ProtocolMessage) {
    // console.log('-> send', message);

    // intercept 'setBreakpoints' request
    if (message.type === 'request' && (<any>message).command === 'setBreakpoints') {
      const args = (<any>message).arguments;
      if (args.source && args.source.path && args.source.path.indexOf('vscode-notebook-cell:') === 0) {
        await this.dumpCell(args.source.path);
      }
    }

    // map Source paths from VS Code to Xeus
    visitSources(message, source => {
      if (source && source.path) {
        const p = this.cellToFile.get(source.path);
        if (p) {
          source.path = p;
        }
      }
    });

    if (message.type === 'request') {
      this.kernel.connection.sendRaw(debugRequest(message as DebugProtocol.Request));
    } else if (message.type === 'response') {
      // responses of reverse requests
      this.kernel.connection.sendRaw(debugResponse(message as DebugProtocol.Response));
    } else {
      // cannot send via iopub, no way to handle events even if they existed
      console.assert(false, `Unknown message type to send ${message.type}`);
    }
  }

  dispose() {
    this.messageListener.unsubscribe();
  }

  /**
   * Dump content of given cell into a tmp file and return path to file.
   */
  private async dumpCell(uri: string): Promise<void> {
    const cell = this.notebookDocument.cells.find(c => c.uri.toString() === uri);
    if (cell) {
      try {
        const response = await this.session.customRequest('dumpCell', { code: cell.document.getText() });
        this.fileToCell.set(response.sourcePath, cell);
        this.cellToFile.set(cell.uri.toString(), response.sourcePath);
      } catch (err) {
        console.log(err);
      }
    }
  }
}

// this vistor could be moved into the DAP npm module (it must be kept in sync with the DAP spec)
function visitSources(msg: DebugProtocol.ProtocolMessage, sourceHook: (source: DebugProtocol.Source | undefined) => void): void {

  switch (msg.type) {
    case 'event':
      const event = <DebugProtocol.Event>msg;
      switch (event.event) {
        case 'output':
          sourceHook((<DebugProtocol.OutputEvent>event).body.source);
          break;
        case 'loadedSource':
          sourceHook((<DebugProtocol.LoadedSourceEvent>event).body.source);
          break;
        case 'breakpoint':
          sourceHook((<DebugProtocol.BreakpointEvent>event).body.breakpoint.source);
          break;
        default:
          break;
      }
      break;
    case 'request':
      const request = <DebugProtocol.Request>msg;
      switch (request.command) {
        case 'setBreakpoints':
          sourceHook((<DebugProtocol.SetBreakpointsArguments>request.arguments).source);
          break;
        case 'breakpointLocations':
          sourceHook((<DebugProtocol.BreakpointLocationsArguments>request.arguments).source);
          break;
        case 'source':
          sourceHook((<DebugProtocol.SourceArguments>request.arguments).source);
          break;
        case 'gotoTargets':
          sourceHook((<DebugProtocol.GotoTargetsArguments>request.arguments).source);
          break;
        default:
          break;
      }
      break;
    case 'response':
      const response = <DebugProtocol.Response>msg;
      if (response.success && response.body) {
        switch (response.command) {
          case 'stackTrace':
            (<DebugProtocol.StackTraceResponse>response).body.stackFrames.forEach(frame => sourceHook(frame.source));
            break;
          case 'loadedSources':
            (<DebugProtocol.LoadedSourcesResponse>response).body.sources.forEach(source => sourceHook(source));
            break;
          case 'scopes':
            (<DebugProtocol.ScopesResponse>response).body.scopes.forEach(scope => sourceHook(scope.source));
            break;
          case 'setFunctionBreakpoints':
            (<DebugProtocol.SetFunctionBreakpointsResponse>response).body.breakpoints.forEach(bp => sourceHook(bp.source));
            break;
          case 'setBreakpoints':
            (<DebugProtocol.SetBreakpointsResponse>response).body.breakpoints.forEach(bp => sourceHook(bp.source));
            break;
          default:
            break;
        }
      }
      break;
  }
}
