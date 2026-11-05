import type { EkkoMessage } from './bridge.ts';

function hasOpenFence(content: string): boolean {
  let fence: { marker: string; length: number } | undefined;
  for (const line of content.split(/\r?\n/)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const [, markers, rest] = match;
    if (fence) {
      if (markers[0] === fence.marker && markers.length >= fence.length && /^[ \t]*$/.test(rest)) fence = undefined;
    } else if (markers[0] !== '`' || !rest.includes('`')) {
      fence = { marker: markers[0], length: markers.length };
    }
  }
  return !!fence;
}

/** Display only: callers retain the untouched message for history, copy and send checks. */
export function projectRoomContent(content: string): { body: string; quote?: { label: string; content: string } } {
  const original = { body: content };
  // Extra, nested or differently spelled raw boundaries are ambiguous, even in the body.
  if ((content.match(/<\s*\/?\s*quoted_message(?=[\s/>])/gi) ?? []).length !== 2) return original;
  // Match only the existing sender's standalone, trailing boundary (LF or CRLF).
  const envelope = /(\r?\n)\1<quoted_message>\1([\s\S]*)\1<\/quoted_message>(?![\s\S])/.exec(content);
  if (!envelope) return original;
  const body = content.slice(0, envelope.index);
  if (!body.trim() || hasOpenFence(body)) return original;
  const inner = envelope[2];
  const heading = /^【([^【】\r\n]+)】\r?\n([\s\S]*)$/.exec(inner);
  if (!heading || !heading[2].trim()) return original;
  const label = heading[1];
  const reply = /^引用：[^\r\n]+$/.test(label) && !!label.slice(3).trim();
  const sourceHeading = /^资料 1：([^\r\n]+) \([A-Za-z0-9_-]+\)，(document|block|selection)(?:，块 ([A-Za-z0-9_-]+))?$/.exec(label);
  const source = !!sourceHeading && !!sourceHeading[1].trim() && (sourceHeading[2] === 'document' || !!sourceHeading[3]);
  if (!reply && !source) return original;
  return { body, quote: { label, content: inner } };
}

export function roomQuoteExcerpt(content: string): string {
  const characters = Array.from(content.replace(/\s+/gu, ' ').trim());
  return characters.length > 160 ? characters.slice(0, 159).join('') + '…' : characters.join('');
}

export function isOwnRoomMessage(item: EkkoMessage, accountUserId: number): boolean {
  return Number.isSafeInteger(accountUserId) && accountUserId > 0 && item.senderId === `auth:${accountUserId}`;
}
