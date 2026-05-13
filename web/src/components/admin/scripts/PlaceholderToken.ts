// M07 — Tiptap PlaceholderToken Mark extension.
//
// Renders {{lead.first_name}} as a non-editable styled chip in the editor.
// Serialized to HTML as: <span data-token data-value="{{lead.first_name}}" ...>{{lead.first_name}}</span>
// The render service strips these span wrappers and interpolates the raw token.

import { Mark, mergeAttributes } from "@tiptap/react";

export const PlaceholderToken = Mark.create({
  name: "placeholderToken",

  addAttributes() {
    return {
      value: {
        default: null,
        parseHTML: (el: Element) => el.getAttribute("data-value"),
        renderHTML: (attrs: Record<string, unknown>) => ({
          "data-value": attrs.value,
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-token]" }];
  },

  renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, {
        "data-token": true,
        class: "placeholder-token",
        contenteditable: "false",
        "aria-label": `token: ${HTMLAttributes["data-value"] ?? ""}`,
        style:
          "display:inline-block;background:var(--color-brand-100,#dbeafe);color:var(--color-brand-700,#1d4ed8);border-radius:4px;padding:1px 6px;font-family:monospace;font-size:0.85em;cursor:default;user-select:none;",
      }),
      0,
    ];
  },

  /**
   * When text matching {{token}} is pasted, convert it to a chip.
   */
  addPasteRules() {
    const markType = this.type;
    return [
      {
        find: /\{\{([a-z][a-z0-9_.]*)\}\}/gi,
        handler({ match, chain, range }: {
          match: RegExpMatchArray;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          chain: any;
          range: { from: number; to: number };
        }) {
          const token = match[0];
          chain()
            .deleteRange(range)
            .insertContent({
              type: "text",
              text: token,
              marks: [{ type: markType.name, attrs: { value: token } }],
            })
            .run();
        },
      },
    ];
  },
});
