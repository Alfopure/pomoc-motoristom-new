export type TelephonyDirectoryContactRole = "client" | "assistance" | "branch" | "partner";

export type TelephonyDirectoryContact = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: TelephonyDirectoryContactRole;
  isFavorite: boolean;
};

export type TelephonyDirectoryResponse = {
  contacts: TelephonyDirectoryContact[];
};

export type TelephonyFavoritesResponse = {
  favorites: TelephonyDirectoryContact[];
};

export type TelephonyFavoriteMutationResponse = {
  contact?: TelephonyDirectoryContact;
  contactId: string;
  isFavorite: boolean;
};

export type TelephonyFavoriteCreateResponse = {
  contact: TelephonyDirectoryContact;
  created: boolean;
};
