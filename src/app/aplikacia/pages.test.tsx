import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import AppPrivacyPage from "./sukromie/page";
import AppSupportPage from "./podpora/page";

describe("public pages of the app", () => {
  it("names the controller, the publisher and the contact", () => {
    const html = renderToStaticMarkup(<AppPrivacyPage />);
    for (const text of ["ALFOPURE s.r.o., IČO 11698055", "MICT, s. r. o., IČO 53 167 422", "mailto:info@alfopure.tech", "/ochrana-hovorov", "požiada až po prijatí pristavenia", "povolenie „Vždy“", "modrým ukazovateľom polohy", "po odhlásení sa posielanie zastaví", "údaje klienta už nezobrazuje", "Polohy pristavovača sa vymažú po 30 dňoch", "<strong>Mapy Apple</strong>",
      "Supabase Auth", "<strong>Google</strong>", "Registre vozidiel", "stkonline.sk", "skp.sk", "NHTSA", "EČV a VIN sa v ňom maskujú",
      "Expo – 650 Industries, Inc., USA", "Apple Push Notification service", "neobsahuje mená, telefónne čísla, EČV ani názov úlohy", "požiada až po ťuknutí na Zapnúť notifikácie"]) expect(html).toContain(text);
  });
  it("tells a dispatcher where to get help without customer data", () => {
    const html = renderToStaticMarkup(<AppSupportPage />);
    for (const text of ["/auth/forgot-password", "/aplikacia/sukromie", "mailto:info@alfopure.tech", "Údaje zákazníkov do správy nepíšte."]) expect(html).toContain(text);
  });
});
