export function codeBlock(contents: string, language = '') {
  return `\`\`\`${language}\n${contents}\n\`\`\``
}
