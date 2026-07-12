export enum AttachmentType {
  Avatar = 'avatar',
  WorkspaceIcon = 'workspace-icon',
  SpaceIcon = 'space-icon',
  File = 'file',
  Chat = 'chat',
}

export const validImageExtensions = ['.jpg', '.png', '.jpeg'];
export const MAX_AVATAR_SIZE = '10MB';

export const SUPPORTED_ATTACHMENT_TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.docx',
  '.pdf',
]);

export const inlineFileExtensions = [
  '.jpg',
  '.png',
  '.jpeg',
  '.pdf',
  '.mp4',
  '.mov',
  '.mp3',
  '.wav',
  '.ogg',
  '.m4a',
  '.webm',
];
