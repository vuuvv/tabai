import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Loads the packaged manifest.
 *
 * Resolved relative to this test file so it works under both ESM and the
 * CommonJS build Vitest uses.
 *
 * @returns The parsed package.json.
 */
function loadManifest(): {
  contributes: {
    commands: { command: string; icon?: unknown; enablement?: string }[];
    menus: Record<string, { command: string; when?: string; group?: string }[]>;
    keybindings: { command: string }[];
    configuration: { properties: Record<string, unknown> };
  };
  activationEvents: string[];
  main: string;
} {
  // `process.cwd()` is the plugin root when Vitest runs.
  const manifestPath = resolve(process.cwd(), 'package.json');
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

describe('package.json manifest', () => {
  it('declares the entry point', () => {
    expect(loadManifest().main).toBe('./dist/extension.js');
  });

  it('activates on startup so the provider registers before the user types', () => {
    expect(loadManifest().activationEvents).toContain('onStartupFinished');
  });

  it('registers every command it exposes in the menu', () => {
    const manifest = loadManifest();
    const declared = new Set(manifest.contributes.commands.map((entry) => entry.command));
    for (const entries of Object.values(manifest.contributes.menus)) {
      for (const entry of entries) {
        // Negative declarations remove a command owned by another extension.
        if (entry.command.startsWith('-')) {
          continue;
        }
        expect(declared.has(entry.command)).toBe(true);
      }
    }
  });

  it('places the commit message command in the SCM input box', () => {
    const inputBox = loadManifest().contributes.menus['scm/inputBox'];
    expect(inputBox).toBeDefined();
    const own = inputBox?.filter((entry) => !entry.command.startsWith('-'));
    expect(own?.map((entry) => entry.command)).toContain('tabai.generateCommitMessage');
  });

  it('restricts the SCM button to the git provider', () => {
    const inputBox = loadManifest().contributes.menus['scm/inputBox'];
    const own = inputBox?.find((entry) => entry.command === 'tabai.generateCommitMessage');
    expect(own?.when).toBe('scmProvider == git');
  });

  it('removes the Copilot commit button from the same slot', () => {
    const inputBox = loadManifest().contributes.menus['scm/inputBox'];
    const negative = inputBox?.find((entry) =>
      entry.command.startsWith('-github.copilot.git.generateCommitMessage'),
    );
    expect(negative).toBeDefined();
  });

  it('gives the SCM command an icon', () => {
    const command = loadManifest().contributes.commands.find(
      (entry) => entry.command === 'tabai.generateCommitMessage',
    );
    expect(command?.icon).toBe('$(sparkle)');
  });

  it('exposes the generate-only command in the SCM title bar', () => {
    const title = loadManifest().contributes.menus['scm/title'];
    expect(title?.map((entry) => entry.command)).toContain('tabai.generateCommitMessage');
  });

  it('does not offer the destructive generate-and-commit in any menu', () => {
    // The command still exists for the palette, but committing must never be
    // one click away next to the message box.
    const manifest = loadManifest();
    for (const entries of Object.values(manifest.contributes.menus)) {
      const commands = entries.map((entry) => entry.command);
      expect(commands).not.toContain('tabai.generateCommitMessageAndCommit');
    }
  });

  it('uses the same sparkle icon for both SCM entry points', () => {
    const manifest = loadManifest();
    const inputBox = manifest.contributes.menus['scm/inputBox']
      .map((entry) => entry.command)
      .filter((command) => !command.startsWith('-'));
    const title = manifest.contributes.menus['scm/title'].map((entry) => entry.command);

    // Both slots render the same command, so they necessarily share an icon.
    expect(inputBox).toEqual(title);
    const command = manifest.contributes.commands.find(
      (entry) => entry.command === 'tabai.generateCommitMessage',
    );
    expect(command?.icon).toBe('$(sparkle)');
  });

  it('declares every command referenced by a keybinding', () => {
    const manifest = loadManifest();
    const declared = new Set(manifest.contributes.commands.map((entry) => entry.command));
    for (const binding of manifest.contributes.keybindings) {
      expect(declared.has(binding.command)).toBe(true);
    }
  });

  it('declares the settings the code reads', () => {
    const properties = loadManifest().contributes.configuration.properties;
    for (const key of [
      'tabai.provider.type',
      'tabai.provider.baseUrl',
      'tabai.provider.completionModel',
      'tabai.provider.commitModel',
      'tabai.completion.enabled',
      'tabai.completion.crossFileContext',
      'tabai.completion.reasoningMode',
      'tabai.logLevel',
      'tabai.git.maxDiffChars',
      'tabai.git.autoCommit',
    ]) {
      expect(properties).toHaveProperty(key);
    }
  });
});
