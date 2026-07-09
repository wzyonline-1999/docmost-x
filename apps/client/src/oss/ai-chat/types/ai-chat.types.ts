export enum ChatMessageRole {
  USER = "user",
  ASSISTANT = "assistant",
  TOOL = "tool",
}

export interface ChatMessage {
  id?: string;
  role: ChatMessageRole | string;
  content?: string;
}

export interface PageMention {
  id: string;
  title?: string;
}

export interface ChatAttachment {
  id?: string;
  name?: string;
  url?: string;
}
