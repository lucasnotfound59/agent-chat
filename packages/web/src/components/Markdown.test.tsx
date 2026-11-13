import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from './Markdown';

describe('Markdown', () => {
  it('renders formatting and highlighted code blocks', () => {
    const { container } = render(<Markdown text={'**粗体**\n\n```ts\nconst a = 1;\n```'} />);
    expect(container.querySelector('strong')?.textContent).toBe('粗体');
    const code = container.querySelector('pre code');
    expect(code?.className).toContain('hljs');
    expect(code?.textContent).toContain('const a = 1;');
  });

  it('drops raw HTML instead of running it', () => {
    const { container } = render(<Markdown text={'<script>window.x=1</script><b>粗</b><img src=x onerror="alert(1)">'} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('opens http links safely and never renders javascript: links', () => {
    const { container } = render(<Markdown text={'[好](https://example.com) [坏](javascript:alert(1))'} />);
    const links = container.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://example.com');
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(container.textContent).toContain('坏');
  });

  it('shows images as text, so an answer cannot make the browser load a remote image', () => {
    const { container } = render(<Markdown text={'![图](https://example.com/a.png)'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('[图片：图]');
  });
});
