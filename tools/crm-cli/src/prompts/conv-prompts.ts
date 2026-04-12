import { editor } from '@inquirer/prompts';

/**
 * Opens $EDITOR for composing multiline message body.
 * Falls back gracefully on terminals without $EDITOR set.
 */
export async function promptMessageBody(label: string): Promise<string> {
  return editor({
    message: label,
    postfix: '.txt',
    waitForUseInput: true,
  });
}
