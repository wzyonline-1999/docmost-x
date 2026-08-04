import { BadRequestException } from '@nestjs/common';
import type { TemplateSnapshot } from '../types/template.types';
import { TemplateRendererService } from './template-renderer.service';

describe('TemplateRendererService', () => {
  const pageService = {
    prepareProsemirrorContent: jest.fn(async (markdown: string) => ({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: `parsed:${markdown}` }],
        },
      ],
    })),
  };
  const service = new TemplateRendererService(pageService as never);

  const snapshot = (
    overrides: Partial<TemplateSnapshot> = {},
  ): TemplateSnapshot => ({
    templateId: '11111111-1111-4111-8111-111111111111',
    version: 1,
    key: 'project-brief',
    title: 'Project brief',
    purpose: 'Create a consistent project brief',
    tags: ['project'],
    inputSchema: {
      type: 'object',
      properties: {
        projectName: { type: 'string' },
        owner: { type: 'string', default: 'Unassigned' },
        summary: { type: 'string', 'x-docmost-type': 'markdown' },
      },
      required: ['projectName'],
      additionalProperties: false,
    },
    titleTemplate: '{{projectName}} brief',
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Owner: {{owner}}' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '{{{summary}}}' }],
        },
      ],
    },
    ...overrides,
  });

  beforeEach(() => jest.clearAllMocks());

  it('validates required variables and rejects undeclared values', async () => {
    await expect(service.render(snapshot(), {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.render(snapshot(), {
        projectName: 'Atlas',
        unknown: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('applies defaults, renders inline variables, and expands markdown blocks', async () => {
    const result = await service.render(snapshot(), {
      projectName: 'Atlas',
      summary: '**Ready**',
    });

    expect(result.title).toBe('Atlas brief');
    expect(result.variables).toEqual({
      projectName: 'Atlas',
      owner: 'Unassigned',
      summary: '**Ready**',
    });
    expect(result.content.content).toEqual([
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Owner: Unassigned' }],
      },
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'parsed:**Ready**' }],
      },
    ]);
    expect(pageService.prepareProsemirrorContent).toHaveBeenCalledWith(
      '**Ready**',
      'markdown',
    );
  });

  it('requires markdown variables to occupy a whole paragraph', async () => {
    const invalid = snapshot({
      content: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Summary: {{{summary}}}' }],
          },
        ],
      },
    });

    await expect(
      service.validateDraft({
        inputSchema: invalid.inputSchema,
        titleTemplate: invalid.titleTemplate,
        content: invalid.content,
      }),
    ).rejects.toThrow('Markdown variables must occupy an entire paragraph');
  });

  it('reports declared variables that the draft does not use', async () => {
    const validation = await service.validateDraft({
      inputSchema: snapshot().inputSchema,
      titleTemplate: '{{projectName}} brief',
      content: { type: 'doc', content: [{ type: 'paragraph' }] },
    });

    expect(validation.warnings).toEqual([
      'Variable is declared but unused: owner',
      'Variable is declared but unused: summary',
    ]);
  });

  it('rejects schema composition and non-string markdown variables', () => {
    expect(() =>
      service.normalizeInputSchema({
        type: 'object',
        properties: {
          value: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        },
        additionalProperties: false,
      }),
    ).toThrow('Unsupported template inputSchema keyword: oneOf');

    expect(() =>
      service.normalizeInputSchema({
        type: 'object',
        properties: {
          value: { type: 'number', 'x-docmost-type': 'markdown' },
        },
        additionalProperties: false,
      }),
    ).toThrow('Markdown template variable must use type=string');
  });
});
