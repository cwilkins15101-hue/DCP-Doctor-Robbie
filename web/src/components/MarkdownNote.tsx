// Ported from the mobile app's MarkdownText — renders "## Header" and "**bold**" markdown
// produced by SOAP-note generators, as plain HTML instead of React Native Text/View.
export function MarkdownNote({ text }: { text: string }) {
  if (!text) return null;
  const lines = text.split('\n');
  return (
    <div>
      {lines.map((line, i) => {
        const isHeader = line.startsWith('## ');
        const content = isHeader ? line.slice(3) : line;
        const parts = content.split(/\*\*(.*?)\*\*/g);
        const rendered = parts.map((part, j) => (j % 2 === 1 ? <b key={j}>{part}</b> : part));
        return isHeader ? (
          <div key={i} className="note-header">{rendered}</div>
        ) : (
          <div key={i} className="note-body">{rendered}</div>
        );
      })}
    </div>
  );
}
