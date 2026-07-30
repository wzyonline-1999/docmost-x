import type { Token, TokenizerAndRendererExtension } from 'marked';

type AdjacentPunctuationStrongToken = Token & {
  type: 'adjacentPunctuationStrong';
  raw: string;
  tokens: Token[];
};

const adjacentPunctuationStrongRegex =
  /^\*\*(?=\S)((?:(?!\*\*).)*?[\p{P}\p{S}])\*\*(?=\S)/u;

export const adjacentPunctuationStrongExtension: TokenizerAndRendererExtension =
  {
    name: 'adjacentPunctuationStrong',
    level: 'inline',
    start(src) {
      const index = src.indexOf('**');
      return index >= 0 ? index : undefined;
    },
    tokenizer(src) {
      const match = adjacentPunctuationStrongRegex.exec(src);
      if (!match) {
        return;
      }

      return {
        type: 'adjacentPunctuationStrong',
        raw: match[0],
        tokens: this.lexer.inlineTokens(match[1]),
      };
    },
    renderer(token) {
      const strongToken = token as AdjacentPunctuationStrongToken;
      return `<strong>${this.parser.parseInline(strongToken.tokens)}</strong>`;
    },
  };
