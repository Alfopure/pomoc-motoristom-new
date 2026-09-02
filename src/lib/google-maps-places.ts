export function createPlaceAutocompleteElement(label: string, value = "", placeholder = label) {
  const element = new google.maps.places.PlaceAutocompleteElement({
    includedRegionCodes: ["sk"],
    noInputIcon: true,
    placeholder,
    requestedLanguage: "sk",
    requestedRegion: "sk",
    unitSystem: google.maps.UnitSystem.METRIC,
    value,
  });
  element.className = "google-place-autocomplete";
  element.setAttribute("aria-label", label);
  return element;
}
