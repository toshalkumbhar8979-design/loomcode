// Markdown parser tests, with focus on GFM pipe tables (alignment + inline
// styles) that the TUI renders as boxed, width-fitted tables.
// Runs with:  bun test src/tui/markdown.test.ts
import { test, expect } from "bun:test";
import { parseMarkdown } from "./markdown.tsx";

test("parses a pipe table with alignment and inline styles", () => {
  const md = [
    "Before",
    "",
    "| Name | Price | Notes |",
    "| :--- | ---: | :---: |",
    "| **Apple** | $1,999 | `M3` |",
    "| Dell | $1,200 | fast |",
    "",
    "After",
  ].join("\n");

  const lines = parseMarkdown(md);
  const table = lines.find((l: any) => l.kind === "table") as any;
  expect(table).toBeTruthy();
  expect(table.headers.map((h: any[]) => h.map((s) => s.text).join(""))).toEqual(["Name", "Price", "Notes"]);
  expect(table.aligns).toEqual(["left", "right", "center"]);
  expect(table.rows).toHaveLength(2);
  expect(table.rows[0][0]).toEqual([{ text: "Apple", bold: true }]);
  expect(table.rows[0][2]).toEqual([{ text: "M3", code: true }]);
  expect(lines.filter((l: any) => l.kind === "text").map((l: any) => l.spans.map((s: any) => s.text).join("")))
    .toEqual(["Before", "", "", "After"]);
});

test("keeps escaped pipes inside a table cell", () => {
  const lines = parseMarkdown([
    "| Expr | Meaning |",
    "| --- | --- |",
    "| a \\| b | either |",
  ].join("\n"));
  const table = lines[0] as any;
  expect(table.kind).toBe("table");
  expect(table.rows[0][0].map((s: any) => s.text).join("")).toBe("a | b");
});

test("does not treat a pipe line without a divider as a table", () => {
  const lines = parseMarkdown("a | b\nc | d");
  expect(lines.every((l: any) => l.kind === "text")).toBe(true);
});

test("pads short rows and ignores extra cells", () => {
  const lines = parseMarkdown([
    "| A | B | C |",
    "| --- | --- | --- |",
    "| 1 |",
    "| 1 | 2 | 3 | 4 |",
  ].join("\n"));
  const table = lines[0] as any;
  expect(table.rows[0]).toHaveLength(3);
  expect(table.rows[0][1]).toEqual([]);
  expect(table.rows[1]).toHaveLength(3);
  expect(table.rows[1][2][0].text).toBe("3");
});
