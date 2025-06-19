const CODE_FENCE = '```'

export function codeBlock(contents: string, language = '') {
  return `${CODE_FENCE}${language}\n${contents}\n${CODE_FENCE}`
}

/**
 * Splits a long string into multiple smaller strings, each under a maximum length.
 * It is aware of Markdown code blocks (```) and ensures they are properly
 * closed and reopened across message splits.
 *
 * Logic stolen from https://github.com/mwittrien/BetterDiscordAddons/blob/master/Plugins/SplitLargeMessages/SplitLargeMessages.plugin.js
 *
 * @param message The long string to split.
 * @returns An array of strings, each within the length limit.
 */
export function split2000(message: string) {
  if (message.length <= 2000)
    return [message]

  const lines = message.split('\n')
  const messages: string[] = []
  let currentMessage = ''

  for (const line of lines) {
    // If a single line is too long, it must be split forcefully.
    if (line.length > 2000) {
      if (currentMessage.length > 0)
        messages.push(currentMessage)
      currentMessage = ''
      for (let i = 0; i < line.length; i += 2000)
        messages.push(line.substring(i, i + 2000))
      continue
    }

    // If adding the next line would exceed the length, push the current message.
    if (currentMessage.length + line.length + 1 > 2000) {
      messages.push(currentMessage)
      currentMessage = line
    }
    else {
      // Otherwise, append the line.
      currentMessage += (currentMessage ? '\n' : '') + line
    }
  }
  // Add the last remaining message part.
  if (currentMessage)
    messages.push(currentMessage)

  // Post-processing to handle code blocks spanning multiple messages.
  const processedMessages: string[] = []
  let isInsideCodeBlock = false
  let language = ''
  for (const msg of messages) {
    let currentMsg = msg
    if (isInsideCodeBlock)
      currentMsg = `${CODE_FENCE}${language}\n${currentMsg}`

    const fenceCount = (currentMsg.match(/```/g) ?? []).length

    if (fenceCount % 2 !== 0) {
      isInsideCodeBlock = true
      const lastFenceIndex = currentMsg.lastIndexOf(CODE_FENCE)
      const openingFence = currentMsg.substring(lastFenceIndex)
      language = openingFence.substring(3).trim() // Get lang from "```lang"
      currentMsg += `\n${CODE_FENCE}`
    }
    else {
      isInsideCodeBlock = false
      language = ''
    }
    processedMessages.push(currentMsg)
  }

  return processedMessages
}

/**
 * Returns the last 2000 characters of a message, ensuring that Markdown
 * code blocks are not broken. If the slice happens inside a code block,
 * it will prepend a new opening fence.
 *
 * @param message The string to truncate.
 * @returns The last part of the string, with valid Markdown.
 */
export function last2000(message: string): string {
  if (message.length <= 2000)
    return message

  // 1980 instead of 2000 to ensure we don't go over 2000 by adding code fences back
  const chunk = message.slice(-1980)
  const precedingText = message.slice(0, message.length - 1980)

  const precedingFences = (precedingText.match(/```/g) ?? []).length
  if (precedingFences % 2 !== 0) {
    // Find the language of the code block we are in.
    const lastFenceIndex = precedingText.lastIndexOf(CODE_FENCE)
    const fenceHeader = precedingText.substring(lastFenceIndex)
    const langMatch = fenceHeader.match(/```(\S*)\n/)
    const language = langMatch ? langMatch[1] : ''

    let rebuiltChunk = `${CODE_FENCE}${language}\n${chunk}`

    // If the total number of fences is now odd, it means the original closing fence was outside the chunk, so we add one.
    const totalFences = (rebuiltChunk.match(/```/g) ?? []).length
    if (totalFences % 2 !== 0)
      rebuiltChunk += `\n${CODE_FENCE}`
    return rebuiltChunk
  }

  return chunk
}
