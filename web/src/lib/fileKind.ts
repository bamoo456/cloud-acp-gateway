// What kind of file a name describes, for the label under an attachment card
// ("Code · SQL") and the glyph beside it.
//
// Extension-only on purpose. The panel labels files the agent named in a tool
// call, and many of them are rows in a list that has not been fetched — there is
// no content to sniff, and a round-trip per row to find out would cost more than
// the label is worth. A wrong guess here is a wrong subtitle, nothing more: the
// viewer decides text-vs-image-vs-binary from the actual bytes server-side.

export type FileIcon = "code" | "image" | "data" | "doc" | "archive" | "file";

export interface FileKind {
  category: string;   // "Code", "Image", … — the first half of the label
  language?: string;  // "SQL", "TypeScript" — the second half, when known
  icon: FileIcon;
}

// Extension -> [category, language]. Only entries that earn their place: the
// languages an agent actually writes, plus the data and doc formats it
// generates. Anything absent still gets a sensible label from its extension.
const BY_EXT: Record<string, [string, string?]> = {
  ts: ["Code", "TypeScript"], tsx: ["Code", "TypeScript"], mts: ["Code", "TypeScript"], cts: ["Code", "TypeScript"],
  js: ["Code", "JavaScript"], jsx: ["Code", "JavaScript"], mjs: ["Code", "JavaScript"], cjs: ["Code", "JavaScript"],
  py: ["Code", "Python"], rb: ["Code", "Ruby"], go: ["Code", "Go"], rs: ["Code", "Rust"],
  java: ["Code", "Java"], kt: ["Code", "Kotlin"], swift: ["Code", "Swift"], scala: ["Code", "Scala"],
  c: ["Code", "C"], h: ["Code", "C"], cc: ["Code", "C++"], cpp: ["Code", "C++"], cxx: ["Code", "C++"], hpp: ["Code", "C++"],
  cs: ["Code", "C#"], php: ["Code", "PHP"], dart: ["Code", "Dart"], lua: ["Code", "Lua"], r: ["Code", "R"],
  ex: ["Code", "Elixir"], exs: ["Code", "Elixir"], pl: ["Code", "Perl"], m: ["Code", "Objective-C"],
  sh: ["Code", "Shell"], bash: ["Code", "Shell"], zsh: ["Code", "Shell"], fish: ["Code", "Shell"],
  sql: ["Code", "SQL"], css: ["Code", "CSS"], scss: ["Code", "SCSS"], less: ["Code", "Less"],
  html: ["Code", "HTML"], htm: ["Code", "HTML"], vue: ["Code", "Vue"], svelte: ["Code", "Svelte"],
  ipynb: ["Code", "Notebook"],

  json: ["Data", "JSON"], jsonl: ["Data", "JSONL"], ndjson: ["Data", "JSONL"],
  yaml: ["Data", "YAML"], yml: ["Data", "YAML"], toml: ["Data", "TOML"], xml: ["Data", "XML"],
  csv: ["Data", "CSV"], tsv: ["Data", "TSV"], ini: ["Data", "INI"], env: ["Data", "ENV"],
  parquet: ["Data", "Parquet"], db: ["Data", "SQLite"], sqlite: ["Data", "SQLite"],

  md: ["Doc", "Markdown"], markdown: ["Doc", "Markdown"], mdx: ["Doc", "MDX"], rst: ["Doc", "reST"],
  txt: ["Text"], log: ["Text", "Log"], pdf: ["Doc", "PDF"], docx: ["Doc", "Word"], xlsx: ["Doc", "Excel"],

  png: ["Image", "PNG"], jpg: ["Image", "JPEG"], jpeg: ["Image", "JPEG"], gif: ["Image", "GIF"],
  webp: ["Image", "WebP"], avif: ["Image", "AVIF"], bmp: ["Image", "BMP"], ico: ["Image", "ICO"],
  svg: ["Image", "SVG"],

  zip: ["Archive", "ZIP"], tar: ["Archive", "TAR"], gz: ["Archive", "GZIP"], tgz: ["Archive", "TAR"],
  bz2: ["Archive", "BZIP2"], xz: ["Archive", "XZ"], "7z": ["Archive", "7Z"], rar: ["Archive", "RAR"],
};

const ICONS: Record<string, FileIcon> = {
  Code: "code", Data: "data", Doc: "doc", Image: "image", Archive: "archive", Text: "file",
};

// Dotfiles that are configuration rather than an extensionless blob. ".env" is
// the everyday one; the rest follow the same "name IS the type" shape.
const BY_NAME: Record<string, [string, string?]> = {
  dockerfile: ["Code", "Docker"], makefile: ["Code", "Make"], ".env": ["Data", "ENV"],
  ".gitignore": ["Data", "Config"], ".gitattributes": ["Data", "Config"],
};

function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  // A leading dot is the whole name (".env"), not an extension of "".
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function fileKind(name: string): FileKind {
  const base = (name.split(/[\\/]/).pop() ?? "").toLowerCase();
  const named = BY_NAME[base];
  if (named) return { category: named[0], language: named[1], icon: ICONS[named[0]] ?? "file" };

  const ext = extensionOf(name);
  const known = BY_EXT[ext];
  if (known) return { category: known[0], language: known[1], icon: ICONS[known[0]] ?? "file" };
  // An unrecognised extension still tells the reader something, so show it
  // rather than flattening everything unknown into "File".
  return { category: "File", language: ext ? ext.toUpperCase() : undefined, icon: "file" };
}

// "Code · SQL", or just "Image" when the category says it all.
export function fileKindLabel(name: string): string {
  const k = fileKind(name);
  return k.language ? k.category + " · " + k.language : k.category;
}
