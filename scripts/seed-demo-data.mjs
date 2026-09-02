import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");

loadDotenv(path.join(rootDir, ".env.local"));

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

if (!supabaseUrl || !serviceKey) {
  console.error("Missing Supabase env. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, serviceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

const ORG = "00000000-0000-4000-8000-000000000001";
const IDS = {
  organizationProfile: "00000000-0000-4000-8000-000000000002",
  natalia: "00000000-0000-4000-8000-000000000101",
  mango: "00000000-0000-4000-8000-000000000102",
  miso: "00000000-0000-4000-8000-000000000103",
  lenka: "00000000-0000-4000-8000-000000000104",
  peter: "00000000-0000-4000-8000-000000000105",
  lineNeutral: "00000000-0000-4000-8000-000000000201",
  lineAllianz: "00000000-0000-4000-8000-000000000202",
  lineAutoklub: "00000000-0000-4000-8000-000000000203",
  lineAxa: "00000000-0000-4000-8000-000000000204",
  lineEurocross: "00000000-0000-4000-8000-000000000205",
};

// Placeholder E.164 numbers; replace with the canonical strings from Telnyx
// `GET /v2/phone_numbers` once the numbers are assigned to the call-control app.
const LINES = [
  { id: IDS.lineNeutral, phone_number: "+421232408700", label: "Neutrálna linka" },
  { id: IDS.lineAllianz, phone_number: "+421232408718", label: "Allianz Assistance" },
  { id: IDS.lineAutoklub, phone_number: "+421232408732", label: "Autoklub Slovakia Assistance" },
  { id: IDS.lineAxa, phone_number: "+421232408760", label: "AXA Assistance CZ" },
  { id: IDS.lineEurocross, phone_number: "+421232408783", label: "Eurocross Assistance CR" },
];
const LINE_BY_ID = new Map(LINES.map((line) => [line.id, line]));

const rows = {
  organizations: [
    {
      id: ORG,
      slug: "pomoc-motoristom",
      name: "Pomoc Motoristom",
      active: true,
    },
  ],
  organizationProfiles: [
    {
      id: IDS.organizationProfile,
      organization_id: ORG,
      brand_name: "Pomoc Motoristom",
      primary_phone: "0850 005 006",
      enabled_modules: ["calls", "cases", "maps", "fleet", "reports", "sms", "attendance"],
    },
  ],
  profiles: [
    {
      id: IDS.natalia,
      organization_id: ORG,
      display_name: "Natália",
      role: "dispatcher",
      active: true,
    },
    {
      id: IDS.mango,
      organization_id: ORG,
      display_name: "Mango",
      role: "senior_dispatcher",
      active: true,
    },
    {
      id: IDS.miso,
      organization_id: ORG,
      display_name: "Michal",
      role: "manager",
      active: true,
    },
    {
      id: IDS.lenka,
      organization_id: ORG,
      display_name: "Lenka",
      role: "dispatcher",
      active: true,
    },
    {
      id: IDS.peter,
      organization_id: ORG,
      display_name: "Peter",
      role: "dispatcher",
      active: true,
    },
  ],
  operatorStatuses: [
    {
      id: "00000000-0000-4000-8000-000000000111",
      organization_id: ORG,
      profile_id: IDS.natalia,
      status: "on_call",
      source: "seed",
      started_at: "2026-05-22T09:12:00+02:00",
    },
    {
      id: "00000000-0000-4000-8000-000000000112",
      organization_id: ORG,
      profile_id: IDS.mango,
      status: "available",
      source: "seed",
      started_at: "2026-05-22T09:05:00+02:00",
    },
    {
      id: "00000000-0000-4000-8000-000000000113",
      organization_id: ORG,
      profile_id: IDS.miso,
      status: "after_call_work",
      source: "seed",
      started_at: "2026-05-22T09:08:00+02:00",
    },
    {
      id: "00000000-0000-4000-8000-000000000114",
      organization_id: ORG,
      profile_id: IDS.lenka,
      status: "paused",
      source: "seed",
      started_at: "2026-05-22T09:01:00+02:00",
    },
    {
      id: "00000000-0000-4000-8000-000000000115",
      organization_id: ORG,
      profile_id: IDS.peter,
      status: "offline",
      source: "seed",
      started_at: "2026-05-22T08:55:00+02:00",
    },
  ],
  attendanceShiftTemplates: [
    attendanceTemplate("00000000-0000-4000-8000-000000001001", "8h nočná", "fixed_8h", "00:00", "08:00", 480, "#0f766e", 10),
    attendanceTemplate("00000000-0000-4000-8000-000000001002", "8h denná", "fixed_8h", "08:00", "16:00", 480, "#2563eb", 20),
    attendanceTemplate("00000000-0000-4000-8000-000000001003", "8h večerná", "fixed_8h", "16:00", "00:00", 480, "#7c3aed", 30),
    attendanceTemplate("00000000-0000-4000-8000-000000001004", "12h denná", "fixed_12h", "08:00", "20:00", 720, "#ea580c", 40),
    attendanceTemplate("00000000-0000-4000-8000-000000001005", "12h nočná", "fixed_12h", "20:00", "08:00", 720, "#334155", 50),
    attendanceTemplate("00000000-0000-4000-8000-000000001006", "Custom výnimka", "custom", null, null, null, "#71717a", 60),
  ],
  attendanceShifts: [
    attendanceShift("00000000-0000-4000-8000-000000001101", IDS.peter, "00000000-0000-4000-8000-000000001001", "confirmed", "2026-05-27", "2026-05-27T00:00:00+02:00", "2026-05-27T08:00:00+02:00", "2026-05-26T17:20:00+02:00"),
    attendanceShift("00000000-0000-4000-8000-000000001102", IDS.natalia, "00000000-0000-4000-8000-000000001002", "confirmed", "2026-05-27", "2026-05-27T08:00:00+02:00", "2026-05-27T16:00:00+02:00", "2026-05-26T16:45:00+02:00"),
    attendanceShift("00000000-0000-4000-8000-000000001103", IDS.mango, "00000000-0000-4000-8000-000000001003", "published", "2026-05-27", "2026-05-27T16:00:00+02:00", "2026-05-28T00:00:00+02:00", null, "Čaká na potvrdenie operátorom."),
    attendanceShift("00000000-0000-4000-8000-000000001104", IDS.miso, "00000000-0000-4000-8000-000000001001", "confirmed", "2026-05-28", "2026-05-28T00:00:00+02:00", "2026-05-28T08:00:00+02:00", "2026-05-26T18:12:00+02:00"),
    attendanceShift("00000000-0000-4000-8000-000000001105", IDS.lenka, "00000000-0000-4000-8000-000000001004", "published", "2026-05-28", "2026-05-28T08:00:00+02:00", "2026-05-28T20:00:00+02:00"),
    attendanceShift("00000000-0000-4000-8000-000000001106", IDS.peter, "00000000-0000-4000-8000-000000001005", "confirmed", "2026-05-28", "2026-05-28T20:00:00+02:00", "2026-05-29T08:00:00+02:00", "2026-05-27T10:10:00+02:00"),
    attendanceShift("00000000-0000-4000-8000-000000001107", IDS.natalia, "00000000-0000-4000-8000-000000001002", "draft", "2026-05-29", "2026-05-29T08:00:00+02:00", "2026-05-29T16:00:00+02:00", null, "Návrh čaká na publikovanie."),
    attendanceShift("00000000-0000-4000-8000-000000001108", IDS.mango, "00000000-0000-4000-8000-000000001006", "confirmed", "2026-05-30", "2026-05-30T10:00:00+02:00", "2026-05-30T18:00:00+02:00", "2026-05-27T12:00:00+02:00", "Custom záskok pre školenie."),
  ],
  attendanceSessions: [
    attendanceSession("00000000-0000-4000-8000-000000001201", IDS.natalia, "00000000-0000-4000-8000-000000001102", "open", "login", "2026-05-27T08:03:00+02:00", null, "Automaticky pripravené pre budúci login flow."),
    attendanceSession("00000000-0000-4000-8000-000000001202", IDS.peter, "00000000-0000-4000-8000-000000001101", "closed", "manual", "2026-05-27T00:01:00+02:00", "2026-05-27T08:02:00+02:00"),
  ],
  telephonyLines: LINES.map((line) => ({
    id: line.id,
    organization_id: ORG,
    provider: "telnyx",
    phone_number: line.phone_number,
    label: line.label,
    active: true,
  })),
  locations: [
    location(
      "00000000-0000-4000-8000-000000000301",
      "Žilina - Pekná",
      "Pekná 30/36, 010 04 Žilina",
      49.2172191,
      18.7170704,
      { source_url: "https://www.zilinskaodtahovka.sk/", verification: "public_contact_page" },
    ),
    location(
      "00000000-0000-4000-8000-000000000302",
      "Bratislava - Panónska",
      "Panónska cesta 43, 851 04 Petržalka",
      48.1025526,
      17.0979155,
      { source_url: "https://www.bratislavskaodtahovka.sk/", verification: "public_contact_page" },
    ),
    location("00000000-0000-4000-8000-000000000303", "Pickup - Vráble", "Hlavná 12, 952 01 Vráble", 48.2435, 18.3086),
    location("00000000-0000-4000-8000-000000000304", "Servis Žilina", "Tolstého 1201/20, 010 01 Žilina", 49.2233, 18.7394),
    location("00000000-0000-4000-8000-000000000305", "Pickup - Bratislava Lamač", "Lamačská cesta, Bratislava", 48.1713, 17.0646),
    location("00000000-0000-4000-8000-000000000306", "Servis Nitra", "Cabajská, Nitra", 48.2797, 18.0864),
    location("00000000-0000-4000-8000-000000000307", "Bratislava - letisko", "Ivanská cesta 16, 821 04 Bratislava", 48.1679, 17.1777),
    location("00000000-0000-4000-8000-000000000308", "Liptovský Mikuláš - stanovište", "1. mája 697/26, 031 01 Liptovský Mikuláš", 49.0841, 19.6104),
    location("00000000-0000-4000-8000-000000000309", "Košice - Barca", "Osloboditeľov, 040 17 Košice", 48.6756, 21.2628),
    location("00000000-0000-4000-8000-000000000310", "Pickup - Ružomberok", "Bystrická cesta, 034 01 Ružomberok", 49.0816, 19.3034),
    location("00000000-0000-4000-8000-000000000311", "Servis Liptovský Mikuláš", "Garbiarska 695, 031 01 Liptovský Mikuláš", 49.0819, 19.6176),
    location("00000000-0000-4000-8000-000000000312", "Pickup - Košice Šaca", "U. S. Steel, Vstupný areál, 044 54 Košice-Šaca", 48.6274, 21.1437),
    location("00000000-0000-4000-8000-000000000313", "Servis Košice", "Južná trieda, 040 01 Košice", 48.6971, 21.2604),
  ],
  branches: [
    branch(
      "00000000-0000-4000-8000-000000000401",
      "Žilina - Pekná",
      "Pekná 30/36, 010 04 Žilina",
      "+421 910 541 622",
      "00000000-0000-4000-8000-000000000301",
      4,
      { source_url: "https://www.zilinskaodtahovka.sk/", verification: "public_contact_page" },
    ),
    branch(
      "00000000-0000-4000-8000-000000000402",
      "Bratislava - Panónska",
      "Panónska cesta 43, 851 04 Petržalka",
      "+421 910 541 622",
      "00000000-0000-4000-8000-000000000302",
      2,
      { source_url: "https://www.bratislavskaodtahovka.sk/", verification: "public_contact_page" },
    ),
    branch(
      "00000000-0000-4000-8000-000000000403",
      "Bratislava - letisko",
      "Ivanská cesta 16, 821 04 Bratislava",
      "0850 005 006",
      "00000000-0000-4000-8000-000000000307",
      3,
      { verification: "demo_dispatch_post", note: "Výjazdové stanovište pre demo, nie overená verejná pobočka." },
    ),
    branch(
      "00000000-0000-4000-8000-000000000404",
      "Liptovský Mikuláš - partner",
      "1. mája 697/26, 031 01 Liptovský Mikuláš",
      "0850 005 006",
      "00000000-0000-4000-8000-000000000308",
      2,
      { verification: "demo_partner_post", note: "Partnerské/výjazdové stanovište pre demo." },
    ),
    branch(
      "00000000-0000-4000-8000-000000000405",
      "Košice - partner",
      "Osloboditeľov, 040 17 Košice",
      "0850 005 006",
      "00000000-0000-4000-8000-000000000309",
      3,
      { verification: "demo_partner_post", note: "Partnerské/výjazdové stanovište pre demo." },
    ),
  ],
  fleetAssets: [
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000501",
      kind: "tow_truck",
      label: "Odťah Žilina 01",
      make: "Iveco",
      model: "Daily",
      license_plate: "ZA-842PM",
      vin: "ZCFC135A005123001",
      status: "available",
      category: "personal_tow",
      weight_kg: 3500,
      branch_id: "00000000-0000-4000-8000-000000000401",
      current_location_id: "00000000-0000-4000-8000-000000000301",
      tow_category: "personal",
      capabilities: ["winch", "immobile", "crashed"],
      assigned_driver_name: "Ján Novák",
      assigned_driver_phone: "+421 905 111 501",
      assigned_driver_status: "on_shift",
      notes: "Bežná odťahovka pre osobné vozidlá v okolí Žiliny.",
      technical_inspection_valid_until: "2027-04-15",
      emission_inspection_valid_until: "2027-04-15",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000502",
      kind: "tow_truck",
      label: "Odťah Bratislava 02",
      make: "Mercedes-Benz",
      model: "Sprinter",
      license_plate: "BA-204AV",
      vin: "W1V9076551P120402",
      status: "available",
      category: "van_tow",
      weight_kg: 5000,
      branch_id: "00000000-0000-4000-8000-000000000403",
      current_location_id: "00000000-0000-4000-8000-000000000307",
      tow_category: "van",
      capabilities: ["winch", "low_garage", "vans", "immobile"],
      assigned_driver_name: "Peter Blaško",
      assigned_driver_phone: "+421 905 111 502",
      assigned_driver_status: "on_shift",
      notes: "Vhodné pre dodávky a zásahy v podzemných garážach.",
      technical_inspection_valid_until: "2026-06-18",
      emission_inspection_valid_until: "2026-06-18",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000503",
      kind: "tow_truck",
      label: "Odťah Liptov 03",
      make: "Renault",
      model: "Master",
      license_plate: "LM-331PM",
      vin: "VF1MA0000P3310012",
      status: "assigned",
      category: "personal_tow",
      weight_kg: 3500,
      branch_id: "00000000-0000-4000-8000-000000000404",
      current_location_id: "00000000-0000-4000-8000-000000000310",
      tow_category: "personal",
      capabilities: ["winch", "immobile"],
      assigned_driver_name: "Dušan Slivka",
      assigned_driver_phone: "+421 905 111 503",
      assigned_driver_status: "on_call",
      occupied_from: "2026-05-22T08:30:00+02:00",
      occupied_until: "2026-05-22T11:00:00+02:00",
      occupancy_type: "case_assignment",
      occupancy_note: "Výjazd Ružomberok -> Liptovský Mikuláš.",
      notes: "Rýchla technika pre Liptov a horské prejazdy.",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000504",
      kind: "tow_truck",
      label: "Odťah Košice 04",
      make: "MAN",
      model: "TGL",
      license_plate: "KE-417PM",
      vin: "WMAN13ZZ6PY431102",
      status: "available",
      category: "specialized_tow",
      weight_kg: 7490,
      branch_id: "00000000-0000-4000-8000-000000000405",
      current_location_id: "00000000-0000-4000-8000-000000000309",
      tow_category: "specialized",
      capabilities: ["winch", "vans", "crashed"],
      assigned_driver_name: "Erik Kováč",
      assigned_driver_phone: "+421 905 111 504",
      assigned_driver_status: "on_shift",
      notes: "Silnejšia technika pre dodávky a havarované vozidlá.",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000505",
      kind: "tow_truck",
      label: "Ťažký odťah Košice 05",
      make: "Volvo",
      model: "FL",
      license_plate: "KE-900TO",
      vin: "YV2T0W1A7P0090055",
      status: "service",
      category: "heavy_tow",
      weight_kg: 12000,
      branch_id: "00000000-0000-4000-8000-000000000405",
      current_location_id: "00000000-0000-4000-8000-000000000309",
      tow_category: "heavy",
      capabilities: ["winch", "trucks", "crashed"],
      assigned_driver_name: "Tibor Hruška",
      assigned_driver_phone: "+421 905 111 505",
      assigned_driver_status: "off_shift",
      notes: "Ťažká technika, dnes kontrola hydrauliky.",
      technical_inspection_valid_until: "2026-06-10",
      emission_inspection_valid_until: "2026-06-10",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000506",
      kind: "replacement_car",
      label: "Náhradné vozidlo Octavia",
      make: "Škoda",
      model: "Octavia Combi",
      license_plate: "ZA-118NV",
      vin: "TMBJJ7NE8P0123001",
      status: "available",
      category: "wagon",
      weight_kg: 1480,
      branch_id: "00000000-0000-4000-8000-000000000401",
      current_location_id: "00000000-0000-4000-8000-000000000301",
      notes: "Univerzálne náhradné vozidlo pre klienta s rodinou.",
      technical_inspection_valid_until: "2026-07-10",
      emission_inspection_valid_until: "2026-07-10",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000507",
      kind: "replacement_car",
      label: "Náhradné vozidlo Corolla",
      make: "Toyota",
      model: "Corolla",
      license_plate: "BA-559PM",
      vin: "SB1K93BE90E559001",
      status: "reserved",
      category: "small_car",
      weight_kg: 1375,
      branch_id: "00000000-0000-4000-8000-000000000403",
      current_location_id: "00000000-0000-4000-8000-000000000307",
      occupied_from: "2026-05-22T13:00:00+02:00",
      occupied_until: "2026-05-24T10:00:00+02:00",
      occupancy_type: "reservation",
      occupancy_note: "Rezervované pre klienta z poistnej udalosti.",
      notes: "Úsporné vozidlo pre krátke mestské náhrady.",
      highway_vignette_valid_until: "2026-06-12",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000508",
      kind: "replacement_car",
      label: "Náhradné vozidlo i30",
      make: "Hyundai",
      model: "i30",
      license_plate: "LM-210NA",
      vin: "TMAH351ABPJ210090",
      status: "rented",
      category: "wagon",
      weight_kg: 1420,
      branch_id: "00000000-0000-4000-8000-000000000404",
      current_location_id: "00000000-0000-4000-8000-000000000308",
      occupied_from: "2026-05-21T16:00:00+02:00",
      occupied_until: "2026-05-25T09:00:00+02:00",
      occupancy_type: "rental",
      occupancy_note: "Prenajaté klientovi po nehode pri Ružomberku.",
      notes: "Náhradné vozidlo pre Liptov.",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000509",
      kind: "replacement_car",
      label: "Náhradné vozidlo Passat",
      make: "Volkswagen",
      model: "Passat Variant",
      license_plate: "KE-902NV",
      vin: "WVWZZZ3CZPE902001",
      status: "available",
      category: "wagon",
      weight_kg: 1560,
      branch_id: "00000000-0000-4000-8000-000000000405",
      current_location_id: "00000000-0000-4000-8000-000000000309",
      notes: "Komfortnejšie náhradné vozidlo pre dlhšiu cestu.",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000510",
      kind: "replacement_car",
      label: "Náhradná dodávka Trafic",
      make: "Renault",
      model: "Trafic",
      license_plate: "BA-742NM",
      vin: "VF1FL0000P7420011",
      status: "available",
      category: "van",
      weight_kg: 2200,
      branch_id: "00000000-0000-4000-8000-000000000403",
      current_location_id: "00000000-0000-4000-8000-000000000307",
      notes: "Náhradná dodávka pre živnostníkov a firemných klientov.",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000511",
      kind: "replacement_car",
      label: "Náhradné SUV Kodiaq",
      make: "Škoda",
      model: "Kodiaq",
      license_plate: "BA-314NV",
      vin: "TMBLJ7NS7P0314001",
      status: "available",
      category: "suv",
      weight_kg: 1725,
      branch_id: "00000000-0000-4000-8000-000000000402",
      current_location_id: "00000000-0000-4000-8000-000000000302",
      notes: "Väčšie náhradné vozidlo pre rodiny alebo klienta s batožinou.",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000512",
      kind: "replacement_car",
      label: "Náhradné vozidlo Ceed",
      make: "Kia",
      model: "Ceed SW",
      license_plate: "ZA-452NV",
      vin: "U5YH251ABPL452008",
      status: "reserved",
      category: "wagon",
      weight_kg: 1450,
      branch_id: "00000000-0000-4000-8000-000000000401",
      current_location_id: "00000000-0000-4000-8000-000000000301",
      occupied_from: "2026-05-22T14:00:00+02:00",
      occupied_until: "2026-05-23T12:00:00+02:00",
      occupancy_type: "reservation",
      occupancy_note: "Rezervované pre klienta po servisnej obhliadke.",
      notes: "Kombi pre bežné poistné udalosti v okolí Žiliny.",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000513",
      kind: "replacement_car",
      label: "Náhradné vozidlo Jogger",
      make: "Dacia",
      model: "Jogger",
      license_plate: "LM-802NV",
      vin: "UU1DJF002P0802007",
      status: "available",
      category: "wagon",
      weight_kg: 1478,
      branch_id: "00000000-0000-4000-8000-000000000404",
      current_location_id: "00000000-0000-4000-8000-000000000308",
      notes: "Jednoduché sedemmiestne náhradné vozidlo pre Liptov.",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000514",
      kind: "replacement_car",
      label: "Náhradné vozidlo 308",
      make: "Peugeot",
      model: "308 SW",
      license_plate: "KE-220NV",
      vin: "VR3F3KFW0PY220019",
      status: "service",
      category: "wagon",
      weight_kg: 1490,
      branch_id: "00000000-0000-4000-8000-000000000405",
      current_location_id: "00000000-0000-4000-8000-000000000309",
      notes: "Čaká na výmenu pneumatík pred ďalším prenájmom.",
      technical_inspection_valid_until: "2026-06-20",
      emission_inspection_valid_until: "2026-06-20",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000515",
      kind: "replacement_car",
      label: "Náhradná dodávka Transit",
      make: "Ford",
      model: "Transit Custom",
      license_plate: "BA-904ND",
      vin: "WF0YXXTTGYPU90422",
      status: "rented",
      category: "van",
      weight_kg: 2450,
      branch_id: "00000000-0000-4000-8000-000000000403",
      current_location_id: "00000000-0000-4000-8000-000000000307",
      occupied_from: "2026-05-20T10:00:00+02:00",
      occupied_until: "2026-05-27T16:00:00+02:00",
      occupancy_type: "rental",
      occupancy_note: "Firemný klient potrebuje náhradu za pracovnú dodávku.",
      notes: "Náhradná dodávka s diaľničnou známkou.",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000516",
      kind: "replacement_car",
      label: "Náhradné vozidlo Astra",
      make: "Opel",
      model: "Astra",
      license_plate: "BA-619NV",
      vin: "W0VBE8EM0P0619003",
      status: "available",
      category: "small_car",
      weight_kg: 1370,
      branch_id: "00000000-0000-4000-8000-000000000402",
      current_location_id: "00000000-0000-4000-8000-000000000302",
      notes: "Kompaktné náhradné vozidlo pre krátke jazdy v Bratislave.",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000517",
      kind: "replacement_car",
      label: "Náhradná dodávka Proace",
      make: "Toyota",
      model: "Proace City",
      license_plate: "KE-118ND",
      vin: "YARXK9HT0P0118018",
      status: "available",
      category: "van",
      weight_kg: 2050,
      branch_id: "00000000-0000-4000-8000-000000000405",
      current_location_id: "00000000-0000-4000-8000-000000000309",
      notes: "Menšia náhradná dodávka pre východné Slovensko.",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000518",
      kind: "tow_truck",
      label: "Odťah Žilina 06",
      make: "Mercedes-Benz",
      model: "Atego",
      license_plate: "ZA-606PM",
      vin: "WDB967021P0606001",
      status: "busy",
      category: "specialized_tow",
      weight_kg: 7500,
      branch_id: "00000000-0000-4000-8000-000000000401",
      current_location_id: "00000000-0000-4000-8000-000000000301",
      tow_category: "specialized",
      capabilities: ["winch", "vans", "immobile", "crashed"],
      assigned_driver_name: "Martin Král",
      assigned_driver_phone: "+421 905 111 518",
      assigned_driver_status: "on_call",
      occupied_from: "2026-05-22T09:10:00+02:00",
      occupied_until: "2026-05-22T12:30:00+02:00",
      occupancy_type: "case_assignment",
      occupancy_note: "Aktuálne na výjazde smer Martin.",
      notes: "Silnejšia plošina pre dodávky a havarované vozidlá.",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000519",
      kind: "tow_truck",
      label: "Ťažký odťah Bratislava 07",
      make: "Scania",
      model: "P 360",
      license_plate: "BA-707TO",
      vin: "YS2P6X200P0707007",
      status: "available",
      category: "heavy_tow",
      weight_kg: 18000,
      branch_id: "00000000-0000-4000-8000-000000000402",
      current_location_id: "00000000-0000-4000-8000-000000000302",
      tow_category: "heavy",
      capabilities: ["winch", "trucks", "crashed"],
      assigned_driver_name: "Róbert Marko",
      assigned_driver_phone: "+421 905 111 519",
      assigned_driver_status: "on_shift",
      notes: "Ťažká technika pre kamióny a veľké dodávky v západnom regióne.",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000520",
      kind: "tow_truck",
      label: "Odťah Liptov 08",
      make: "Isuzu",
      model: "NPR",
      license_plate: "LM-808PM",
      vin: "JAANPR75HP0808008",
      status: "available",
      category: "van_tow",
      weight_kg: 5500,
      branch_id: "00000000-0000-4000-8000-000000000404",
      current_location_id: "00000000-0000-4000-8000-000000000308",
      tow_category: "van",
      capabilities: ["winch", "low_garage", "vans", "immobile"],
      assigned_driver_name: "Lukáš Ferko",
      assigned_driver_phone: "+421 905 111 520",
      assigned_driver_status: "available",
      notes: "Kompaktnejšia odťahovka pre Liptov a nižšie prístupy.",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000521",
      kind: "replacement_car",
      label: "Náhradné vozidlo A4 Avant",
      make: "Audi",
      model: "A4 Avant",
      license_plate: "BA-441NV",
      vin: "WAUZZZF41PN044100",
      status: "available",
      category: "wagon",
      weight_kg: 1585,
      branch_id: "00000000-0000-4000-8000-000000000402",
      current_location_id: "00000000-0000-4000-8000-000000000302",
      notes: "Prémiovejšie náhradné vozidlo pre klienta s vyššou triedou vozidla.",
    }),
    fleetAsset({
      id: "00000000-0000-4000-8000-000000000522",
      kind: "replacement_car",
      label: "Náhradná dodávka Jumper",
      make: "Citroen",
      model: "Jumper",
      license_plate: "ZA-622ND",
      vin: "VF7YCBMFC12P62209",
      status: "available",
      category: "van",
      weight_kg: 2925,
      branch_id: "00000000-0000-4000-8000-000000000401",
      current_location_id: "00000000-0000-4000-8000-000000000301",
      notes: "Väčšia náhradná dodávka pre remeselníkov a firemné zásahy.",
    }),
  ],
  contacts: [
    contact("00000000-0000-4000-8000-000000000601", "Peter Kováč", "+421 905 778 122", "client"),
    contact("00000000-0000-4000-8000-000000000602", "Europe Assistance", "+421 232 111 222", "assistance"),
    contact("00000000-0000-4000-8000-000000000603", "Jana Horváthová", "+421 907 330 114", "client"),
    contact("00000000-0000-4000-8000-000000000604", "Marek Sýkora", "+421 918 442 909", "client"),
  ],
  vehicles: [
    vehicle("00000000-0000-4000-8000-000000000701", "ZA-382HL", "Škoda", "Fabia", "osobné", false, "Nehoda, blokované predné koleso"),
    vehicle("00000000-0000-4000-8000-000000000702", "BA-771XM", "BMW", "X3", "SUV", false, "Porucha prevodovky, podzemná garáž -2"),
    vehicle("00000000-0000-4000-8000-000000000703", "RK-442BC", "Volkswagen", "Golf", "osobné", false, "Defekt a poškodené zavesenie po náraze do výtlku"),
    vehicle("00000000-0000-4000-8000-000000000704", "KE-889DT", "Mercedes-Benz", "Sprinter", "dodávka", false, "Dodávka nepojazdná, plne naložená"),
  ],
  cases: [
    dispatchCase({
      id: "00000000-0000-4000-8000-000000000801",
      case_number: "PM-2026-0517",
      status: "triage",
      priority: "urgent",
      source_type: "client",
      case_type: "Odťah + náhradné vozidlo",
      owner_id: IDS.natalia,
      contact_id: "00000000-0000-4000-8000-000000000601",
      vehicle_id: "00000000-0000-4000-8000-000000000701",
      pickup_location_id: "00000000-0000-4000-8000-000000000303",
      destination_location_id: "00000000-0000-4000-8000-000000000304",
      selected_asset_id: "00000000-0000-4000-8000-000000000501",
      summary: "Klient po nehode potrebuje odťah do partnerského servisu a náhradné vozidlo.",
      main_note: "Overiť, či je vozidlo mimo jazdného pruhu.",
      created_at: "2026-05-22T08:18:00+02:00",
      updated_at: "2026-05-22T08:24:00+02:00",
    }),
    dispatchCase({
      id: "00000000-0000-4000-8000-000000000802",
      case_number: "PM-2026-0518",
      status: "assigned",
      priority: "high",
      source_type: "assistance",
      case_type: "Asistenčný odťah",
      owner_id: IDS.mango,
      contact_id: "00000000-0000-4000-8000-000000000602",
      vehicle_id: "00000000-0000-4000-8000-000000000702",
      pickup_location_id: "00000000-0000-4000-8000-000000000305",
      destination_location_id: "00000000-0000-4000-8000-000000000306",
      selected_asset_id: "00000000-0000-4000-8000-000000000502",
      summary: "Asistenčka poslala objednávku, čaká sa potvrdenie techniky pre garáž.",
      main_note: "Garáž -2, overiť výšku a prístup. Možný problém s klasickou odťahovkou.",
      created_at: "2026-05-22T08:42:00+02:00",
      updated_at: "2026-05-22T08:48:00+02:00",
    }),
    dispatchCase({
      id: "00000000-0000-4000-8000-000000000803",
      case_number: "PM-2026-0520",
      status: "scheduled",
      priority: "normal",
      source_type: "partner",
      case_type: "Náhradné vozidlo",
      owner_id: IDS.miso,
      contact_id: "00000000-0000-4000-8000-000000000603",
      vehicle_id: "00000000-0000-4000-8000-000000000703",
      pickup_location_id: "00000000-0000-4000-8000-000000000310",
      destination_location_id: "00000000-0000-4000-8000-000000000311",
      selected_asset_id: "00000000-0000-4000-8000-000000000508",
      summary: "Klientka potrebuje náhradné vozidlo počas opravy po udalosti pri Ružomberku.",
      main_note: "Auto bude prevzaté na Liptove, náhradné vozidlo je už v prenájme do pondelka.",
      created_at: "2026-05-22T09:03:00+02:00",
      updated_at: "2026-05-22T09:15:00+02:00",
    }),
    dispatchCase({
      id: "00000000-0000-4000-8000-000000000804",
      case_number: "PM-2026-0521",
      status: "triage",
      priority: "urgent",
      source_type: "client",
      case_type: "Odťah dodávky",
      owner_id: IDS.natalia,
      contact_id: "00000000-0000-4000-8000-000000000604",
      vehicle_id: "00000000-0000-4000-8000-000000000704",
      pickup_location_id: "00000000-0000-4000-8000-000000000312",
      destination_location_id: "00000000-0000-4000-8000-000000000313",
      selected_asset_id: "00000000-0000-4000-8000-000000000504",
      summary: "Naložená dodávka je nepojazdná pri Košiciach, treba techniku vhodnú pre dodávky.",
      main_note: "Overiť hmotnosť nákladu a možnosť manipulácie na mieste.",
      created_at: "2026-05-22T09:20:00+02:00",
      updated_at: "2026-05-22T09:22:00+02:00",
    }),
  ],
  caseTasks: [
    task("00000000-0000-4000-8000-000000000821", "00000000-0000-4000-8000-000000000801", "Poslať lokalizačnú SMS a potvrdiť ETA", IDS.natalia, "2026-05-22T09:30:00+02:00", "high", "sms"),
    task("00000000-0000-4000-8000-000000000822", "00000000-0000-4000-8000-000000000802", "Overiť nízku plošinu pre garáž", IDS.mango, "2026-05-22T09:45:00+02:00", "high", "dispatch"),
    task("00000000-0000-4000-8000-000000000823", "00000000-0000-4000-8000-000000000803", "Pripraviť dostupnosť náhradného vozidla", IDS.miso, "2026-05-22T10:10:00+02:00", "normal", "handover"),
    task("00000000-0000-4000-8000-000000000824", "00000000-0000-4000-8000-000000000804", "Zistiť reálnu hmotnosť dodávky", IDS.natalia, "2026-05-22T09:40:00+02:00", "urgent", "dispatch"),
  ],
  taskReminders: [
    reminder(
      "00000000-0000-4000-8000-000000000861",
      "00000000-0000-4000-8000-000000000801",
      "00000000-0000-4000-8000-000000000821",
      IDS.natalia,
      "private",
      "2026-05-22T09:30:00+02:00",
      "sent",
    ),
    reminder(
      "00000000-0000-4000-8000-000000000862",
      "00000000-0000-4000-8000-000000000803",
      "00000000-0000-4000-8000-000000000823",
      null,
      "team",
      "2026-05-22T10:10:00+02:00",
      "sent",
    ),
  ],
  notifications: [
    notification(
      "00000000-0000-4000-8000-000000000871",
      "00000000-0000-4000-8000-000000000801",
      "00000000-0000-4000-8000-000000000821",
      "00000000-0000-4000-8000-000000000861",
      IDS.natalia,
      "private",
      "task_overdue",
      "urgent",
      "PM-2026-0517: Poslať lokalizačnú SMS a potvrdiť ETA",
      "SMS · termín 09:30",
      "00000000-0000-4000-8000-000000000821:00000000-0000-4000-8000-000000000861:00000000-0000-4000-8000-000000000101:2026-05-22T07:30:00.000Z",
      "2026-05-22T09:30:15+02:00",
    ),
    notification(
      "00000000-0000-4000-8000-000000000872",
      "00000000-0000-4000-8000-000000000803",
      "00000000-0000-4000-8000-000000000823",
      "00000000-0000-4000-8000-000000000862",
      null,
      "team",
      "handover",
      "warning",
      "PM-2026-0520: Pripraviť dostupnosť náhradného vozidla",
      "Odovzdanie · termín 10:10",
      "00000000-0000-4000-8000-000000000823:00000000-0000-4000-8000-000000000862:team:2026-05-22T08:10:00.000Z",
      "2026-05-22T10:10:08+02:00",
    ),
  ],
  caseEvents: [
    event("00000000-0000-4000-8000-000000000841", "00000000-0000-4000-8000-000000000801", IDS.natalia, "case_created", "Prípad založený", "Prichádzajúci hovor na linku pomoci.", "2026-05-22T08:18:00+02:00"),
    event("00000000-0000-4000-8000-000000000842", "00000000-0000-4000-8000-000000000802", IDS.mango, "case_assigned", "Technika priradená", "Vybraná odťahovka Bratislava 02 pre garážový zásah.", "2026-05-22T08:48:00+02:00"),
    event("00000000-0000-4000-8000-000000000843", "00000000-0000-4000-8000-000000000803", IDS.miso, "replacement_car_reserved", "Náhradné vozidlo pripravené", "i30 je rezervovaná pre klientku na Liptove.", "2026-05-22T09:15:00+02:00"),
    event("00000000-0000-4000-8000-000000000844", "00000000-0000-4000-8000-000000000804", IDS.natalia, "case_created", "Prípad založený", "Dodávka pri Košiciach, odporúčaná špecializovaná technika.", "2026-05-22T09:22:00+02:00"),
  ],
  calls: [
    call("00000000-0000-4000-8000-000000000901", "mock-telnyx-2026-0517", IDS.lineNeutral, "incoming", "+421 905 778 122", "Peter Kováč", "00000000-0000-4000-8000-000000000801", IDS.natalia, "2026-05-22T09:12:00+02:00", 42),
    call("00000000-0000-4000-8000-000000000902", "mock-telnyx-2026-0518", IDS.lineAllianz, "answered", "+421 232 111 222", "Europe Assistance", "00000000-0000-4000-8000-000000000802", IDS.mango, "2026-05-22T08:42:00+02:00", 14, "2026-05-22T08:42:14+02:00", "2026-05-22T08:48:00+02:00"),
    call("00000000-0000-4000-8000-000000000903", "mock-telnyx-2026-0521", IDS.lineNeutral, "answered", "+421 918 442 909", "Marek Sýkora", "00000000-0000-4000-8000-000000000804", IDS.natalia, "2026-05-22T09:20:00+02:00", 18, "2026-05-22T09:20:18+02:00", null),
  ],
  callEvents: [
    callEvent("00000000-0000-4000-8000-000000000911", "00000000-0000-4000-8000-000000000901", "mock-telnyx-2026-0517", "call.initiated", "mock-telnyx-2026-0517-initiated", "2026-05-22T09:12:00+02:00"),
    callEvent("00000000-0000-4000-8000-000000000912", "00000000-0000-4000-8000-000000000902", "mock-telnyx-2026-0518", "call.answered", "mock-telnyx-2026-0518-answered", "2026-05-22T08:42:14+02:00"),
    callEvent("00000000-0000-4000-8000-000000000913", "00000000-0000-4000-8000-000000000903", "mock-telnyx-2026-0521", "call.answered", "mock-telnyx-2026-0521-answered", "2026-05-22T09:20:18+02:00"),
  ],
};

await upsert("motorist_organizations", rows.organizations);
await upsert("motorist_organization_profiles", rows.organizationProfiles);
await upsert("motorist_profiles", rows.profiles);
await upsert("motorist_operator_statuses", rows.operatorStatuses);
await upsert("motorist_attendance_shift_templates", rows.attendanceShiftTemplates);
await upsert("motorist_attendance_shifts", rows.attendanceShifts);
await upsert("motorist_attendance_sessions", rows.attendanceSessions);
await upsert("motorist_telephony_lines", rows.telephonyLines);
await upsert("motorist_locations", rows.locations);
await upsert("motorist_branches", rows.branches);
await upsert("motorist_fleet_assets", rows.fleetAssets);
await upsert("motorist_contacts", rows.contacts);
await upsert("motorist_vehicles", rows.vehicles);
await upsert("motorist_cases", rows.cases);
await upsert("motorist_case_tasks", rows.caseTasks);
await upsert("motorist_task_reminders", rows.taskReminders);
await upsert("motorist_notifications", rows.notifications);
await upsert("motorist_case_events", rows.caseEvents);
await upsert("motorist_calls", rows.calls);
await upsert(
  "motorist_call_events",
  rows.callEvents.map(withoutId),
  "organization_id,provider,event_fingerprint",
);

console.log("Demo data seeded:");
console.log(`- ${rows.branches.length} branches`);
console.log(`- ${rows.fleetAssets.length} fleet assets`);
console.log(`- ${rows.cases.length} dispatch cases`);
console.log(`- ${rows.notifications.length} notifications`);
console.log(`- ${rows.attendanceShifts.length} attendance shifts`);

function loadDotenv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    const key = trimmed.slice(0, equalsIndex).trim();
    const value = unquote(trimmed.slice(equalsIndex + 1).trim());

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}

async function upsert(table, data, onConflict = "id") {
  const { error } = await supabase.from(table).upsert(data, { onConflict });

  if (error) {
    throw new Error(`${table}: ${error.message}`);
  }
}

function attendanceTemplate(id, label, kind, startsAtLocal, endsAtLocal, plannedMinutes, color, sortOrder) {
  return {
    id,
    organization_id: ORG,
    label,
    kind,
    starts_at_local: startsAtLocal,
    ends_at_local: endsAtLocal,
    planned_minutes: plannedMinutes,
    color,
    sort_order: sortOrder,
    active: true,
  };
}

function attendanceShift(id, profileId, templateId, status, dateLocal, plannedStartAt, plannedEndAt, confirmedAt = null, notes = null) {
  return {
    id,
    organization_id: ORG,
    profile_id: profileId,
    template_id: templateId,
    status,
    date_local: dateLocal,
    timezone: "Europe/Bratislava",
    planned_start_at: plannedStartAt,
    planned_end_at: plannedEndAt,
    published_at: status === "draft" ? null : "2026-05-26T09:00:00+02:00",
    confirmed_at: confirmedAt,
    notes,
  };
}

function attendanceSession(id, profileId, shiftId, status, source, startedAt, endedAt = null, notes = null) {
  return {
    id,
    organization_id: ORG,
    profile_id: profileId,
    shift_id: shiftId,
    status,
    source,
    started_at: startedAt,
    ended_at: endedAt,
    notes,
  };
}

function reminder(id, caseId, taskId, recipientProfileId, visibility, scheduledFor, status) {
  return {
    id,
    organization_id: ORG,
    case_id: caseId,
    task_id: taskId,
    recipient_profile_id: recipientProfileId,
    visibility,
    channels: ["in_app"],
    scheduled_for: scheduledFor,
    status,
    dedupe_key: `${taskId}:${recipientProfileId || "team"}:${new Date(scheduledFor).toISOString()}`,
    created_by: recipientProfileId,
    payload: { source: "seed" },
  };
}

function notification(id, caseId, taskId, reminderId, recipientProfileId, visibility, kind, severity, title, body, dedupeKey, createdAt) {
  return {
    id,
    organization_id: ORG,
    case_id: caseId,
    task_id: taskId,
    reminder_id: reminderId,
    recipient_profile_id: recipientProfileId,
    visibility,
    kind,
    severity,
    title,
    body,
    status: "unread",
    delivery_status: "in_app",
    dedupe_key: dedupeKey,
    payload: { source: "seed" },
    created_at: createdAt,
  };
}

function location(id, label, address, lat, lng, metadata = {}) {
  return {
    id,
    organization_id: ORG,
    label,
    address,
    lat,
    lng,
    provider: "seed",
    metadata,
  };
}

function branch(id, name, address, phone, locationId, availableReplacementCars, metadata = {}) {
  return {
    id,
    organization_id: ORG,
    name,
    address,
    phone,
    location_id: locationId,
    available_replacement_cars: availableReplacementCars,
    active: true,
    metadata,
  };
}

function fleetAsset(input) {
  return {
    organization_id: ORG,
    insurance_valid_until: input.insurance_valid_until ?? "2027-01-31",
    highway_vignette_valid_until: input.highway_vignette_valid_until ?? "2026-12-31",
    technical_inspection_valid_until: input.technical_inspection_valid_until ?? "2027-03-31",
    emission_inspection_valid_until: input.emission_inspection_valid_until ?? "2027-03-31",
    capabilities: input.capabilities ?? [],
    assigned_driver_name: input.assigned_driver_name ?? null,
    assigned_driver_phone: input.assigned_driver_phone ?? null,
    assigned_driver_status: input.assigned_driver_status ?? null,
    last_seen_at: input.last_seen_at ?? "2026-05-22T09:20:00+02:00",
    ...input,
  };
}

function contact(id, name, phone, role) {
  return {
    id,
    organization_id: ORG,
    name,
    phone,
    role,
  };
}

function vehicle(id, licensePlate, make, model, category, isDriveable, notes) {
  return {
    id,
    organization_id: ORG,
    license_plate: licensePlate,
    make,
    model,
    category,
    is_driveable: isDriveable,
    notes,
  };
}

function dispatchCase(input) {
  return {
    organization_id: ORG,
    ...input,
  };
}

function task(id, caseId, title, assignedTo, dueAt, priority = "normal", kind = "other") {
  return {
    id,
    organization_id: ORG,
    case_id: caseId,
    title,
    assigned_to: assignedTo,
    due_at: dueAt,
    status: "open",
    priority,
    kind,
    created_by: assignedTo,
  };
}

function event(id, caseId, actorProfileId, eventType, title, body, createdAt) {
  return {
    id,
    organization_id: ORG,
    case_id: caseId,
    actor_profile_id: actorProfileId,
    event_type: eventType,
    title,
    body,
    created_at: createdAt,
  };
}

function call(id, providerSessionId, lineId, status, callerNumber, callerName, caseId, operatorId, startedAt, waitSeconds, answeredAt = null, endedAt = null) {
  const line = LINE_BY_ID.get(lineId);
  return {
    id,
    organization_id: ORG,
    provider: "telnyx",
    provider_session_id: providerSessionId,
    direction: "inbound",
    status,
    caller_number: callerNumber,
    caller_name: callerName,
    called_number: line.phone_number,
    received_number: line.phone_number,
    line_id: lineId,
    operator_id: operatorId,
    case_id: caseId,
    started_at: startedAt,
    answered_at: answeredAt,
    ended_at: endedAt,
    wait_seconds: waitSeconds,
    raw_payload: { source: "seed" },
  };
}

function callEvent(id, callId, providerSessionId, eventType, fingerprint, providerCreatedAt) {
  return {
    id,
    organization_id: ORG,
    call_id: callId,
    provider: "telnyx",
    provider_session_id: providerSessionId,
    event_type: eventType,
    event_fingerprint: fingerprint,
    payload: { source: "seed" },
    provider_created_at: providerCreatedAt,
  };
}

function withoutId(row) {
  const copy = { ...row };
  delete copy.id;
  return copy;
}
