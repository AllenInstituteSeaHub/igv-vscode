/**
 * Lifecycle of the agent control channel inside the extension (spec §6.2,
 * §6.4): start the server, write the instance registry, inject
 * IGV_VSCODE_ENDPOINT / IGV_VSCODE_TOKEN and the launcher dir into integrated
 * terminals, keep lastActiveAt fresh, and tear everything down on deactivate.
 * Disabled in Restricted Mode or when igv.agent.enabled is false.
 */
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from '../log';
import type { HostKind, InstanceRecord } from './protocol';
import { ControlServer, newInstanceId, type MethodHandler } from './ControlServer';
import { removeInstance, touchInstance, writeInstance } from './registry';
import { installOnPath, writeLaunchers, type LauncherPaths } from './CliInstaller';

export interface AgentServiceDeps {
  context: vscode.ExtensionContext;
  log: Logger;
  handler: MethodHandler;
  version: string;
  host: HostKind;
}

export type AgentDisabledReason = 'restricted-mode' | 'setting' | undefined;

export class AgentService implements vscode.Disposable {
  readonly instanceId = newInstanceId();
  private server: ControlServer | undefined;
  private launchers: LauncherPaths | undefined;
  private touchTimer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;

  constructor(private readonly deps: AgentServiceDeps) {}

  get enabled(): boolean {
    return this.server?.listening === true;
  }

  get disabledReason(): AgentDisabledReason {
    if (!vscode.workspace.isTrusted) return 'restricted-mode';
    if (vscode.workspace.getConfiguration('igv').get<boolean>('agent.enabled', true) === false) return 'setting';
    return undefined;
  }

  get endpoint(): string | undefined {
    return this.server?.endpoint;
  }

  get token(): string | undefined {
    return this.server?.token;
  }

  get launcherPaths(): LauncherPaths | undefined {
    return this.launchers;
  }

  /** Path of dist/cli.js inside the installed extension. */
  get cliPath(): string {
    return path.join(this.deps.context.extensionUri.fsPath, 'dist', 'cli.js');
  }

  async start(): Promise<void> {
    const { context, log } = this.deps;
    // Launchers are always written: the CLI itself works without the server (help, version, mcp docs).
    try {
      const binDir = path.join(context.globalStorageUri.fsPath, 'bin');
      this.launchers = await writeLaunchers(binDir, process.execPath, this.cliPath);
      context.environmentVariableCollection.description = 'IGV Viewer: igv-vscode CLI on PATH and the agent control channel';
      context.environmentVariableCollection.prepend('PATH', binDir + path.delimiter);
      log.info(`CLI launcher written to ${this.launchers.posix} (runtime ${process.execPath})`, 'agent');
    } catch (err) {
      log.error(`could not write CLI launchers: ${(err as Error).message}`, 'agent');
    }

    const reason = this.disabledReason;
    if (reason) {
      log.warn(`agent control channel disabled (${reason === 'restricted-mode' ? 'workspace is in Restricted Mode' : 'igv.agent.enabled is false'})`, 'agent');
      context.environmentVariableCollection.delete('IGV_VSCODE_ENDPOINT');
      context.environmentVariableCollection.delete('IGV_VSCODE_TOKEN');
      return;
    }

    const server = new ControlServer(
      {
        handler: this.deps.handler,
        log: (level, message) => log.log(level, message, 'agent'),
        onActivity: () => void touchInstance(this.instanceId),
      },
      this.instanceId,
    );
    try {
      await server.start();
    } catch (err) {
      log.error(`could not start the agent control channel: ${(err as Error).message}`, 'agent');
      return;
    }
    this.server = server;
    context.environmentVariableCollection.replace('IGV_VSCODE_ENDPOINT', server.endpoint);
    context.environmentVariableCollection.replace('IGV_VSCODE_TOKEN', server.token);
    await this.writeRegistry();
    this.touchTimer = setInterval(() => void touchInstance(this.instanceId), 30_000);
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.writeRegistry()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('igv.agent.enabled') && this.disabledReason === 'setting') {
          void vscode.window.showInformationMessage('IGV: the agent API will be disabled after the window is reloaded.');
        }
      }),
    );
  }

  private async writeRegistry(): Promise<void> {
    if (!this.server) return;
    const now = new Date().toISOString();
    const record: InstanceRecord = {
      id: this.instanceId,
      endpoint: this.server.endpoint,
      token: this.server.token,
      pid: process.pid,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      startedAt: now,
      lastActiveAt: now,
      version: this.deps.version,
      host: this.deps.host,
    };
    try {
      const file = await writeInstance(record);
      this.deps.log.info(`instance registered at ${file}`, 'agent');
    } catch (err) {
      this.deps.log.warn(`could not write the instance registry: ${(err as Error).message}`, 'agent');
    }
  }

  /** "IGV: Install CLI on PATH" */
  async installCliOnPath(): Promise<string> {
    if (!this.launchers) throw new Error('CLI launchers were not written; see the IGV output channel');
    const r = await installOnPath(this.launchers);
    this.deps.log.info(r.message, 'agent');
    return r.message;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.touchTimer) clearInterval(this.touchTimer);
    void removeInstance(this.instanceId);
    void this.server?.stop();
  }
}
