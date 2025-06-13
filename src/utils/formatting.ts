export function codeBlock(contents: string, language = '') {
  return `\`\`\`${language}\n${contents}\n\`\`\``
}

export function last2000(message: string) {
  // TODO: respect markdown, dont break codeblocks
  return message.slice(message.length - 2000)
}
