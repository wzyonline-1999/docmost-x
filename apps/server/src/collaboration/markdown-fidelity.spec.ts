import { markdownToHtml } from '../../../../packages/editor-ext/src/lib/markdown/utils/marked.utils';
import { htmlToMarkdown } from '../../../../packages/editor-ext/src/lib/markdown/utils/turndown.utils';

describe('Markdown fidelity', () => {
  it.each([
    [
      '**任务系统与业务治理：**青团',
      '<strong>任务系统与业务治理：</strong>青团',
    ],
    [
      '- **任务系统与业务治理：**青团',
      '<li><strong>任务系统与业务治理：</strong>青团</li>',
    ],
    [
      '**任务系统与业务治理：** 青团',
      '<strong>任务系统与业务治理：</strong> 青团',
    ],
    ['**普通粗体**正文', '<strong>普通粗体</strong>正文'],
  ])('preserves intended strong emphasis in %s', async (markdown, expected) => {
    const html = await markdownToHtml(markdown);
    expect(html).toContain(expected);
  });

  it('does not reinterpret emphasis-like text inside inline or fenced code', async () => {
    const html = await markdownToHtml(
      '`**任务系统与业务治理：**青团`\n\n```\n**任务系统与业务治理：**青团\n```',
    );

    expect(html).toContain('<code>**任务系统与业务治理：**青团</code>');
    expect(html).toContain('**任务系统与业务治理：**青团\n</code></pre>');
    expect(html).not.toContain(
      '<code><strong>任务系统与业务治理：</strong>青团</code>',
    );
  });

  it('promotes the first row of a headerless table instead of adding an empty header', () => {
    const markdown = htmlToMarkdown(`
      <table>
        <tbody>
          <tr><td>模块</td><td>内容</td></tr>
          <tr><td>任务系统</td><td>业务治理</td></tr>
        </tbody>
      </table>
    `);

    expect(markdown).toContain('| 模块');
    expect(markdown).toContain('| --- | --- |');
    expect(markdown).toContain('| 任务系统');
    expect(markdown).not.toMatch(/^\|\s*\|\s*\|\s*$/m);
  });

  it('keeps an existing table header unchanged', () => {
    const markdown = htmlToMarkdown(`
      <table>
        <thead><tr><th>模块</th><th>内容</th></tr></thead>
        <tbody><tr><td>任务系统</td><td>业务治理</td></tr></tbody>
      </table>
    `);

    expect(markdown.match(/^\| --- \| --- \|$/gm)).toHaveLength(1);
    expect(markdown).not.toMatch(/^\|\s*\|\s*\|\s*$/m);
  });

  it('preserves column alignment while promoting a headerless table', () => {
    const markdown = htmlToMarkdown(`
      <table>
        <tbody>
          <tr>
            <td style="text-align: left">名称</td>
            <td style="text-align: center">状态</td>
            <td style="text-align: right">数量</td>
          </tr>
          <tr><td>任务</td><td>完成</td><td>3</td></tr>
        </tbody>
      </table>
    `);

    expect(markdown).toContain('| :--- | :---: | ---: |');
  });

  it('repairs a previously generated empty table header', () => {
    const markdown = htmlToMarkdown(`
      <table>
        <thead>
          <tr><th></th><th></th></tr>
        </thead>
        <tbody>
          <tr><td>模块</td><td>内容</td></tr>
          <tr><td>任务系统</td><td>业务治理</td></tr>
        </tbody>
      </table>
    `);

    expect(markdown).toContain('| 模块');
    expect(markdown).toContain('| --- | --- |');
    expect(markdown).not.toMatch(/^\|\s*\|\s*\|\s*$/m);
  });

  it('leaves complex headerless tables to the existing HTML preservation rules', () => {
    const markdown = htmlToMarkdown(`
      <table>
        <tbody>
          <tr><td>模块</td><td><ul><li>内容</li></ul></td></tr>
          <tr><td>任务系统</td><td>业务治理</td></tr>
        </tbody>
      </table>
    `);

    expect(markdown).toContain('<table>');
    expect(markdown).toContain('<ul>');
  });
});
