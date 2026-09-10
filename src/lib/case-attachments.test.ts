import { describe, expect, it } from "vitest";

import { CASE_ATTACHMENT_ACCEPT, MAX_CASE_ATTACHMENT_BYTES, validateCaseAttachmentFiles } from "./case-attachments";

const file = (overrides: Partial<{ name: string; size: number; type: string }> = {}) => ({
  name: "faktura.pdf",
  size: 12_345,
  type: "application/pdf",
  ...overrides,
});

describe("case attachment validation", () => {
  it("accepts the supported document and image types within the limit", () => {
    expect(validateCaseAttachmentFiles([file(), file({ name: "foto.jpg", type: "image/jpeg" }), file({ name: "foto.png", type: "image/png" })])).toBeNull();
    expect(validateCaseAttachmentFiles([])).toBeNull();
  });

  it("names the first offending file: empty, too large or of a refused type", () => {
    expect(validateCaseAttachmentFiles([file({ name: "prazdny.pdf", size: 0 })])).toBe("Súbor prazdny.pdf je prázdny.");
    expect(validateCaseAttachmentFiles([file({ name: "velky.pdf", size: MAX_CASE_ATTACHMENT_BYTES + 1 })])).toBe("Súbor velky.pdf presahuje limit 10 MB.");
    expect(validateCaseAttachmentFiles([file(), file({ name: "skript.exe", type: "application/x-msdownload" })])).toBe("Typ súboru application/x-msdownload nie je povolený.");
    expect(validateCaseAttachmentFiles([file({ name: "bez-typu", type: "" })])).toBe("Typ súboru neznámy nie je povolený.");
  });

  it("offers the browser exactly the types the server accepts", () => {
    expect(CASE_ATTACHMENT_ACCEPT.split(",")).toEqual(["image/jpeg", "image/png", "application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]);
  });
});
