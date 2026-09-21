import { dispatchCases } from "../../src/mock/seed";
import { collaborationCard } from "./case-collaboration-data";
export const syncCard = { ...dispatchCases[0], ...collaborationCard, pickup: dispatchCases[0].pickup };
