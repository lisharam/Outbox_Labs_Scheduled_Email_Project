const corrections = new Map([
  ['dont', "don't"],
  ['doesnt', "doesn't"],
  ['didnt', "didn't"],
  ['cant', "can't"],
  ['couldnt', "couldn't"],
  ['wont', "won't"],
  ['wouldnt', "wouldn't"],
  ['isnt', "isn't"],
  ['arent', "aren't"],
  ['wasnt', "wasn't"],
  ['werent', "weren't"],
  ['im', "I'm"],
  ['ive', "I've"],
  ['ill', "I'll"],
  ['id', "I'd"],
  ['teh', 'the'],
  ['thier', 'their'],
  ['recieve', 'receive'],
  ['recieved', 'received'],
  ['adress', 'address'],
  ['seperate', 'separate'],
  ['definately', 'definitely'],
  ['occured', 'occurred'],
  ['alot', 'a lot'],
]);

function cleanText(text) {
  let cleaned = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([,.!?;:])([^\s\n])/g, '$1 $2')
    .replace(/\b([a-z]+)(?:\s+\1\b)+/gi, '$1')
    .replace(/\bi\b/g, 'I');

  for (const [misspelling, correction] of corrections) {
    cleaned = cleaned.replace(new RegExp(`\\b${misspelling}\\b`, 'gi'), correction);
  }

  cleaned = cleaned.replace(/(^|[.!?]\s+)([a-z])/g, (_match, prefix, letter) => `${prefix}${letter.toUpperCase()}`);
  return cleaned.trim();
}

function makeConcise(text) {
  return cleanText(text)
    .replace(/\b(very|really|basically|actually)\s+/gi, '')
    .replace(/\b(in order to)\b/gi, 'to')
    .replace(/\b(due to the fact that)\b/gi, 'because')
    .replace(/\b(at this point in time)\b/gi, 'now')
    .replace(/\b(I just wanted to)\b/gi, 'I want to')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function makeWarmer(text) {
  let result = cleanText(text)
    .replace(/\bDear\b/i, 'Hello')
    .replace(/\bPlease send\b/gi, 'Could you please send')
    .replace(/\bI need you to\b/gi, 'Could you please')
    .replace(/\bASAP\b/gi, 'when you have a chance');
  if (!/^(hi|hello|dear)\b/i.test(result)) result = `Hi,\n\n${result}`;
  if (!/(thanks|thank you|best regards|kind regards)[.!]?$/i.test(result)) result += '\n\nThank you!';
  return result;
}

function makeSubject(text) {
  const firstLine = cleanText(text).split(/\n|(?<=[.!?])\s/)[0];
  const words = firstLine.replace(/[.!?]+$/, '').split(/\s+/).slice(0, 9);
  const subject = words.join(' ');
  return subject.length > 72 ? `${subject.slice(0, 69).trimEnd()}...` : subject;
}

export function writeOffline({ text, task }) {
  const cleaned = cleanText(text);
  if (task === 'subject') return makeSubject(text);
  if (task === 'concise') return makeConcise(text);
  if (task === 'warmer') return makeWarmer(text);
  if (task === 'generate') {
    return `Hello,\n\n${cleaned}\n\nPlease let me know if you have any questions.\n\nBest regards,`;
  }
  return cleaned;
}
