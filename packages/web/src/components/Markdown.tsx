import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';

const SAFE_URL = /^(https?:|mailto:)/i;

/**
 * Agent answers are untrusted: raw HTML is dropped, only http(s)/mailto links survive and open in a
 * new tab, and images become text (no remote loads). Otherwise an answer could run script and read
 * the token in localStorage.
 */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        skipHtml
        rehypePlugins={[rehypeHighlight]}
        urlTransform={(url) => (SAFE_URL.test(url) ? url : '')}
        components={{
          a: ({ href, children }) =>
            href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            ),
          img: ({ alt, src }) => <span>[图片：{alt || src}]</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
