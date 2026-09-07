import { describe, expect, it } from "vitest";
import { renderSmsTemplate, SMS_TEMPLATES, validateTemplateMessage } from "./templates";
const context = { caseNumber: "PM-123", callbackNumber: "+421905123456", link: `https://sms.example/l/${"a".repeat(43)}`, etaMinutes: 18, towAddress: "Dielenska 12, Bratislava" };
describe("SMS templates", () => {
  it.each(SMS_TEMPLATES)("renders $key with one callback and no placeholders", ({ key }) => {
    const message = renderSmsTemplate(key, context);
    expect(message).toContain("Na SMS neodpovedajte.");
    expect(message.split(context.callbackNumber)).toHaveLength(2);
    expect(message).not.toMatch(/\{[^}]+\}/);
    expect(() => validateTemplateMessage(key, context, message)).not.toThrow();
  });
  it("requires every variable and a bounded explicit ETA", () => {
    expect(() => renderSmsTemplate("location_request", { ...context, link: "" })).toThrow();
    expect(() => renderSmsTemplate("eta_update", { ...context, etaMinutes: undefined })).toThrow();
    expect(() => renderSmsTemplate("delay", { ...context, etaMinutes: -1 })).toThrow();
    expect(() => renderSmsTemplate("tow_destination", { ...context, towAddress: "" })).toThrow();
    expect(() => renderSmsTemplate("callback", { ...context, callbackNumber: "" })).toThrow();
  });
  it("keeps the real server link in an edited message", () => {
    const message = renderSmsTemplate("location_request", context);
    expect(() => validateTemplateMessage("location_request", context, message.replace(context.link, "https://other.example"))).toThrow();
    expect(() => validateTemplateMessage("location_request", context, `Dobry den. ${message}`)).not.toThrow();
  });
});
