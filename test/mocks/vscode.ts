/**
 * A minimal in-memory stand-in for the `vscode` module.
 *
 * The extension's pure logic is tested directly, but the thin adapters
 * (`vscodeProvider`, `gitCommands`, `extensionCommands`) still import
 * `vscode`. This module provides just enough surface for those adapters to run
 * under Node, and records every interaction so tests can assert on them.
 *
 * `vitest.config.ts` aliases the `vscode` specifier to this file.
 */

/** A recorded call to `showErrorMessage` / `showWarningMessage` etc. */
export interface RecordedMessage {
  /** Which API was called. */
  kind: 'info' | 'warning' | 'error';
  /** The message text. */
  message: string;
  /** Extra arguments passed to the call. */
  args: unknown[];
}

/** Mutable state shared by every mock instance within one test file. */
export const mockState: {
  messages: RecordedMessage[];
  executedCommands: { command: string; args: unknown[] }[];
  updatedConfiguration: { key: string; value: unknown; target: unknown }[];
  inlineProvider: InlineCompletionItemProvider | undefined;
  disposables: { dispose: () => void }[];
  clipboard: string;
  progressCalls: number;
  activeTextEditor: TextEditorLike | undefined;
  workspaceFolders: FolderLike[] | undefined;
  configuration: Record<string, unknown>;
  modelList: string[];
  openDocuments: TextDocumentLike[];
  workspaceFiles: { toString(): string; fsPath: string; scheme: string }[];
  fileContents: Record<string, string>;
  repositories: {
    rootUri: { fsPath: string };
    inputBox: { value: string };
  }[];
} = {
  messages: [],
  executedCommands: [],
  updatedConfiguration: [],
  inlineProvider: undefined,
  disposables: [],
  clipboard: '',
  progressCalls: 0,
  activeTextEditor: undefined,
  workspaceFolders: undefined,
  configuration: {},
  modelList: [],
  openDocuments: [],
  workspaceFiles: [],
  fileContents: {},
  repositories: [{ rootUri: { fsPath: '/repo' }, inputBox: { value: '' } }],
};

/**
 * Resets every piece of recorded state.
 *
 * Called from `beforeEach` so tests do not leak into each other.
 */
export function resetMockState(): void {
  mockState.messages = [];
  mockState.executedCommands = [];
  mockState.updatedConfiguration = [];
  mockState.inlineProvider = undefined;
  mockState.disposables = [];
  mockState.clipboard = '';
  mockState.progressCalls = 0;
  mockState.activeTextEditor = undefined;
  mockState.workspaceFolders = undefined;
  mockState.configuration = {};
  mockState.modelList = [];
  mockState.openDocuments = [];
  mockState.workspaceFiles = [];
  mockState.fileContents = {};
  mockState.repositories = [{ rootUri: { fsPath: '/repo' }, inputBox: { value: '' } }];
}

/** A position value object. */
export class Position {
  /** Zero-based line. */
  public readonly line: number;

  /** Zero-based character. */
  public readonly character: number;

  /**
   * @param line Zero-based line.
   * @param character Zero-based character.
   */
  public constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }
}

/** A range value object. */
export class Range {
  /** Start position. */
  public readonly start: Position;

  /** End position. */
  public readonly end: Position;

  /**
   * @param startLine Start line.
   * @param startCharacter Start character.
   * @param endLine End line.
   * @param endCharacter End character.
   */
  public constructor(
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number,
  ) {
    this.start = new Position(startLine, startCharacter);
    this.end = new Position(endLine, endCharacter);
  }
}

/** The inline completion item produced by the provider. */
export class InlineCompletionItem {
  /** Text to insert. */
  public readonly insertText: string;

  /** Range the ghost text occupies. */
  public readonly range: Range;

  /**
   * @param insertText Text to insert.
   * @param range Range the ghost text occupies.
   */
  public constructor(insertText: string, range: Range) {
    this.insertText = insertText;
    this.range = range;
  }
}

/** Trigger kinds, mirroring the VS Code enum. */
export const InlineCompletionTriggerKind = {
  /** Triggered automatically while typing. */
  Automatic: 0,
  /** Triggered by an explicit command. */
  Invoke: 1,
} as const;

/** The union of {@link InlineCompletionTriggerKind} values. */
export type InlineCompletionTriggerKindValue =
  (typeof InlineCompletionTriggerKind)[keyof typeof InlineCompletionTriggerKind];

/** Progress locations, mirroring the VS Code enum. */
export enum ProgressLocation {
  /** Notification area. */
  Notification = 15,
  /** Source control panel. */
  SourceControl = 1,
}

/** Configuration scopes, mirroring the VS Code enum. */
export enum ConfigurationTarget {
  /** User settings. */
  Global = 1,
  /** Workspace settings. */
  Workspace = 2,
}

/** The shape of an inline completion provider used by the mock registry. */
export interface InlineCompletionItemProvider {
  /**
   * Produces inline completion items.
   *
   * @param document The document.
   * @param position The cursor position.
   * @param context The context.
   * @param token The cancellation token.
   * @returns Items or undefined.
   */
  provideInlineCompletionItems(
    document: TextDocumentLike,
    position: Position,
    context: { triggerKind: InlineCompletionTriggerKindValue },
    token: { isCancellationRequested: boolean; onCancellationRequested(l: () => void): { dispose(): void } },
  ): Promise<InlineCompletionItem[] | undefined>;
}

/** The document shape the adapters consume. */
export interface TextDocumentLike {
  /** Document URI. */
  uri: { toString(): string; scheme: string; fsPath: string };
  /** Language id. */
  languageId: string;
  /** Document version. */
  version: number;
  /** Number of lines. */
  lineCount: number;
  /** File name. */
  fileName: string;
  /**
   * Returns the full text.
   *
   * @returns The document text.
   */
  getText(): string;
}

/** The editor shape the adapters consume. */
export interface TextEditorLike {
  /** The document in the editor. */
  document: TextDocumentLike;
}

/** A workspace folder shape. */
export interface FolderLike {
  /** Folder URI. */
  uri: { fsPath: string };
}

/** A disposable whose `dispose` records the call. */
class MockDisposable {
  /** Records that the disposable was released. */
  public dispose(): void {
    // Intentionally empty; presence is what tests assert on.
  }
}

/** The `window` namespace of the mock. */
export const window = {
  /** The active editor, if any. */
  get activeTextEditor(): TextEditorLike | undefined {
    return mockState.activeTextEditor;
  },

  /**
   * Records an information message.
   *
   * @param message The message.
   * @param args Extra arguments.
   * @returns The first button label, or undefined.
   */
  async showInformationMessage(message: string, ...args: unknown[]): Promise<string | undefined> {
    mockState.messages.push({ kind: 'info', message, args });
    const buttons = args.filter((arg): arg is string => typeof arg === 'string');
    return buttons[0];
  },

  /**
   * Records a warning message.
   *
   * @param message The message.
   * @param args Extra arguments.
   * @returns Always undefined.
   */
  async showWarningMessage(message: string, ...args: unknown[]): Promise<undefined> {
    mockState.messages.push({ kind: 'warning', message, args });
    return undefined;
  },

  /**
   * Records an error message.
   *
   * @param message The message.
   * @param args Extra arguments.
   * @returns Always undefined.
   */
  async showErrorMessage(message: string, ...args: unknown[]): Promise<undefined> {
    mockState.messages.push({ kind: 'error', message, args });
    return undefined;
  },

  /**
   * Runs the task with a no-op progress reporter.
   *
   * @param _options Progress options, ignored.
   * @param task The task to run.
   * @returns The task result.
   */
  async withProgress<T>(
    _options: unknown,
    task: (progress: unknown, token: { onCancellationRequested(l: () => void): { dispose(): void } }) => Promise<T>,
  ): Promise<T> {
    mockState.progressCalls += 1;
    return task({}, { onCancellationRequested: () => new MockDisposable() });
  },

  /**
   * Creates a no-op output channel.
   *
   * @param _name Channel name, ignored.
   * @returns A channel stub.
   */
  createOutputChannel(_name: string): {
    appendLine: (line: string) => void;
    dispose: () => void;
  } {
    const lines: string[] = [];
    return {
      appendLine: (line: string) => {
        lines.push(line);
      },
      dispose: () => undefined,
    };
  },
};

/** The `workspace` namespace of the mock. */
export const workspace = {
  /** The open folders, if any. */
  get workspaceFolders(): FolderLike[] | undefined {
    return mockState.workspaceFolders;
  },

  /**
   * Returns a configuration facade backed by `mockState.configuration`.
   *
   * @param _section Ignored section name.
   * @returns The configuration facade.
   */
  getConfiguration(_section?: string): {
    get<T>(key: string, defaultValue: T): T;
    update(key: string, value: unknown, target: unknown): Promise<void>;
  } {
    return {
      get<T>(key: string, defaultValue: T): T {
        const stored = mockState.configuration[key];
        return stored === undefined ? defaultValue : (stored as T);
      },
      async update(key: string, value: unknown, target: unknown): Promise<void> {
        mockState.configuration[key] = value;
        mockState.updatedConfiguration.push({ key, value, target });
      },
    };
  },

  /**
   * Resolves the workspace folder containing a URI.
   *
   * @param uri The URI to look up.
   * @returns The containing folder, or undefined.
   */
  getWorkspaceFolder(uri: { fsPath: string }): FolderLike | undefined {
    return mockState.workspaceFolders?.find((folder) =>
      uri.fsPath.startsWith(folder.uri.fsPath),
    );
  },

  /**
   * Returns the open documents recorded in `mockState`.
   *
   * @returns Open text documents.
   */
  get textDocuments(): TextDocumentLike[] {
    return mockState.openDocuments;
  },

  /**
   * Lists workspace files matching a glob.
   *
   * @param _include Include glob, ignored by the mock.
   * @param _exclude Exclude glob, ignored by the mock.
   * @param _maxResults Result cap, ignored by the mock.
   * @returns The URIs recorded in `mockState.workspaceFiles`.
   */
  async findFiles(_include: string, _exclude?: string, _maxResults?: number): Promise<
    { toString(): string; fsPath: string; scheme: string }[]
  > {
    return mockState.workspaceFiles;
  },

  /** Filesystem facade backed by `mockState.fileContents`. */
  fs: {
    /**
     * Reads a file through the mock filesystem.
     *
     * @param uri The URI to read.
     * @returns The recorded bytes.
     */
    async readFile(uri: { fsPath: string }): Promise<Uint8Array> {
      const content = mockState.fileContents[uri.fsPath];
      if (content === undefined) {
        throw new Error('ENOENT: ' + uri.fsPath);
      }
      return new TextEncoder().encode(content);
    },
  },

  /**
   * Converts an absolute path to a workspace-relative one.
   *
   * @param uri The URI to relativise.
   * @returns A repository-relative path.
   */
  asRelativePath(uri: { fsPath: string }): string {
    const root = mockState.workspaceFolders?.[0]?.uri.fsPath ?? '';
    return root.length > 0 && uri.fsPath.startsWith(root)
      ? uri.fsPath.slice(root.length).replace(/^\//, '')
      : uri.fsPath;
  },

  /**
   * Registers a configuration-change listener.
   *
   * @param _listener The listener.
   * @returns A disposable.
   */
  onDidChangeConfiguration(_listener: (event: { affectsConfiguration(s: string): boolean }) => void): MockDisposable {
    return new MockDisposable();
  },
};

/** The `languages` namespace of the mock. */
export const languages = {
  /**
   * Captures the registered inline completion provider.
   *
   * @param _selector The document selector.
   * @param provider The provider.
   * @returns A disposable.
   */
  registerInlineCompletionItemProvider(
    _selector: unknown,
    provider: InlineCompletionItemProvider,
  ): MockDisposable {
    mockState.inlineProvider = provider;
    return new MockDisposable();
  },
};

/** The `commands` namespace of the mock. */
export const commands = {
  /** Registered command handlers, keyed by command id. */
  registered: new Map<string, (...args: unknown[]) => unknown>(),

  /**
   * Registers a command handler.
   *
   * @param id The command id.
   * @param handler The handler.
   * @returns A disposable.
   */
  registerCommand(id: string, handler: (...args: unknown[]) => unknown): MockDisposable {
    commands.registered.set(id, handler);
    return new MockDisposable();
  },

  /**
   * Records and resolves an executed command.
   *
   * @param command The command id.
   * @param args Command arguments.
   * @returns Always undefined.
   */
  async executeCommand(command: string, ...args: unknown[]): Promise<undefined> {
    mockState.executedCommands.push({ command, args });
    return undefined;
  },
};

/** The `env` namespace of the mock. */
export const env = {
  /** Clipboard facade backed by `mockState.clipboard`. */
  clipboard: {
    /**
     * Writes text to the mock clipboard.
     *
     * @param text Text to store.
     */
    async writeText(text: string): Promise<void> {
      mockState.clipboard = text;
    },
  },
};

/** The `extensions` namespace of the mock. */
export const extensions = {
  /**
   * Looks up a built-in extension; the git API is simulated via `mockState`.
   *
   * @param _id The extension id.
   * @returns A stub exposing the git API.
   */
  getExtension(_id: string): { exports: unknown } | undefined {
    return {
      exports: {
        getAPI: () => ({
          repositories: mockState.repositories,
        }),
      },
    };
  },
};

/** The `scm` namespace of the mock. */
export const scm = {
  /**
   * Creates a no-op source control.
   *
   * @param _id Source control id.
   * @param _label Source control label.
   * @returns A stub with a `dispose` method.
   */
  createSourceControl(_id: string, _label: string): { dispose: () => void } {
    return { dispose: () => undefined };
  },
};

/** The `Uri` namespace of the mock. */
export const Uri = {
  /**
   * Creates a file URI.
   *
   * @param fsPath Filesystem path.
   * @returns A URI-like object.
   */
  file(fsPath: string): { fsPath: string; scheme: string; toString(): string } {
    return {
      fsPath,
      scheme: 'file',
      toString: () => 'file://' + fsPath,
    };
  },
};
