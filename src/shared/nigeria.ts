export interface NigeriaStateHub {
  name: string;
  capital: string;
  region: 'South West' | 'South South' | 'South East' | 'North Central' | 'North West' | 'North East';
  lat: number;
  lng: number;
}

export const NIGERIA_STATES: NigeriaStateHub[] = [
  { name: 'Lagos', capital: 'Ikeja', region: 'South West', lat: 6.5244, lng: 3.3792 },
  { name: 'FCT Abuja', capital: 'Abuja', region: 'North Central', lat: 9.0765, lng: 7.3986 },
  { name: 'Rivers', capital: 'Port Harcourt', region: 'South South', lat: 4.8156, lng: 7.0498 },
  { name: 'Kano', capital: 'Kano', region: 'North West', lat: 12.0022, lng: 8.5920 },
  { name: 'Oyo', capital: 'Ibadan', region: 'South West', lat: 7.3775, lng: 3.9470 },
  { name: 'Ogun', capital: 'Abeokuta', region: 'South West', lat: 7.1475, lng: 3.3619 },
  { name: 'Enugu', capital: 'Enugu', region: 'South East', lat: 6.4584, lng: 7.5464 },
  { name: 'Anambra', capital: 'Awka', region: 'South East', lat: 6.2107, lng: 7.0741 },
  { name: 'Delta', capital: 'Asaba', region: 'South South', lat: 6.2059, lng: 6.6959 },
  { name: 'Edo', capital: 'Benin City', region: 'South South', lat: 6.3350, lng: 5.6037 },
  { name: 'Kaduna', capital: 'Kaduna', region: 'North West', lat: 10.5105, lng: 7.4165 },
  { name: 'Plateau', capital: 'Jos', region: 'North Central', lat: 9.8965, lng: 8.8583 },
  { name: 'Cross River', capital: 'Calabar', region: 'South South', lat: 4.9757, lng: 8.3417 },
  { name: 'Akwa Ibom', capital: 'Uyo', region: 'South South', lat: 5.0377, lng: 7.9128 },
  { name: 'Abia', capital: 'Umuahia', region: 'South East', lat: 5.5249, lng: 7.4946 },
  { name: 'Imo', capital: 'Owerri', region: 'South East', lat: 5.4891, lng: 7.0176 },
  { name: 'Kwara', capital: 'Ilorin', region: 'North Central', lat: 8.4799, lng: 4.5418 },
  { name: 'Osun', capital: 'Osogbo', region: 'South West', lat: 7.7827, lng: 4.5418 },
  { name: 'Ondo', capital: 'Akure', region: 'South West', lat: 7.2571, lng: 5.2058 },
  { name: 'Ekiti', capital: 'Ado Ekiti', region: 'South West', lat: 7.6211, lng: 5.2214 },
  { name: 'Borno', capital: 'Maiduguri', region: 'North East', lat: 11.8311, lng: 13.1510 },
  { name: 'Adamawa', capital: 'Yola', region: 'North East', lat: 9.2035, lng: 12.4954 },
  { name: 'Bauchi', capital: 'Bauchi', region: 'North East', lat: 10.3158, lng: 9.8442 },
  { name: 'Benue', capital: 'Makurdi', region: 'North Central', lat: 7.7322, lng: 8.5391 },
  { name: 'Niger', capital: 'Minna', region: 'North Central', lat: 9.5836, lng: 6.5463 },
  { name: 'Kogi', capital: 'Lokoja', region: 'North Central', lat: 7.7969, lng: 6.7405 },
  { name: 'Nasarawa', capital: 'Lafia', region: 'North Central', lat: 8.4939, lng: 8.5153 },
  { name: 'Sokoto', capital: 'Sokoto', region: 'North West', lat: 13.0059, lng: 5.2476 },
  { name: 'Katsina', capital: 'Katsina', region: 'North West', lat: 12.9816, lng: 7.6223 },
  { name: 'Bayelsa', capital: 'Yenagoa', region: 'South South', lat: 4.9267, lng: 6.2676 },
  { name: 'Ebonyi', capital: 'Abakaliki', region: 'South East', lat: 6.3249, lng: 8.1137 },
  { name: 'Gombe', capital: 'Gombe', region: 'North East', lat: 10.2897, lng: 11.1673 },
  { name: 'Taraba', capital: 'Jalingo', region: 'North East', lat: 8.8937, lng: 11.3596 },
  { name: 'Yobe', capital: 'Damaturu', region: 'North East', lat: 11.7470, lng: 11.9608 },
  { name: 'Jigawa', capital: 'Dutse', region: 'North West', lat: 11.7562, lng: 9.3389 },
  { name: 'Kebbi', capital: 'Birnin Kebbi', region: 'North West', lat: 12.4539, lng: 4.1975 },
  { name: 'Zamfara', capital: 'Gusau', region: 'North West', lat: 12.1628, lng: 6.6745 },
];

export const NIGERIA_HIGHWAY_CORRIDORS: Array<[string, string]> = [
  ['Lagos', 'Ogun'],
  ['Ogun', 'Oyo'],
  ['Oyo', 'Kwara'],
  ['Kwara', 'Niger'],
  ['Niger', 'FCT Abuja'],
  ['Oyo', 'Osun'],
  ['Osun', 'Ondo'],
  ['Ondo', 'Edo'],
  ['Edo', 'Delta'],
  ['Delta', 'Anambra'],
  ['Anambra', 'Enugu'],
  ['Enugu', 'Abia'],
  ['Abia', 'Rivers'],
  ['Rivers', 'Akwa Ibom'],
  ['Akwa Ibom', 'Cross River'],
  ['FCT Abuja', 'Kogi'],
  ['Kogi', 'Edo'],
  ['FCT Abuja', 'Kaduna'],
  ['Kaduna', 'Kano'],
  ['Kaduna', 'Plateau'],
  ['Plateau', 'Bauchi'],
  ['Bauchi', 'Gombe'],
  ['Gombe', 'Borno'],
  ['FCT Abuja', 'Nasarawa'],
  ['Nasarawa', 'Benue'],
];

export function findStateHub(stateName: string): NigeriaStateHub {
  const normalized = stateName.trim().toLowerCase();
  return (
    NIGERIA_STATES.find((s) => s.name.toLowerCase() === normalized) ||
    NIGERIA_STATES[0]
  );
}

const LANDMARK_COORDS: Array<{ state: string; keyword: string; label: string; lat: number; lng: number }> = [
  { state: 'Katsina', keyword: 'kofar kaura', label: 'Kofar Kaura, Katsina', lat: 12.9818, lng: 7.6122 },
  { state: 'Katsina', keyword: 'batagarawa', label: 'Batagarawa, Katsina', lat: 12.9056, lng: 7.6011 },
  { state: 'Katsina', keyword: 'kofar marusa', label: 'Kofar Marusa, Katsina', lat: 12.9762, lng: 7.6245 },
  { state: 'Katsina', keyword: 'gra', label: 'GRA, Katsina', lat: 12.9715, lng: 7.6085 },
  { state: 'Katsina', keyword: 'sabon layi', label: 'Sabon Layi, Katsina', lat: 12.9891, lng: 7.5994 },
  { state: 'Katsina', keyword: 'dutsin-ma', label: 'Dutsin-Ma Road, Katsina', lat: 12.4539, lng: 7.4972 },
  { state: 'Katsina', keyword: 'kofar sauri', label: 'Kofar Sauri, Katsina', lat: 12.9964, lng: 7.5982 },
  { state: 'Katsina', keyword: 'kofar guga', label: 'Kofar Guga, Katsina', lat: 12.9905, lng: 7.6028 },
  { state: 'Lagos', keyword: 'victoria island', label: 'Adeola Odeku, Victoria Island', lat: 6.4281, lng: 3.4219 },
  { state: 'Lagos', keyword: 'lekki', label: 'Admiralty Way, Lekki Phase 1', lat: 6.4474, lng: 3.4723 },
  { state: 'Lagos', keyword: 'ikeja', label: 'Allen Avenue, Ikeja', lat: 6.6018, lng: 3.3515 },
  { state: 'Lagos', keyword: 'ikoyi', label: 'Bourdillon Road, Ikoyi', lat: 6.4549, lng: 3.4346 },
  { state: 'Lagos', keyword: 'surulere', label: 'Adeniran Ogunsanya, Surulere', lat: 6.4969, lng: 3.3612 },
  { state: 'FCT Abuja', keyword: 'wuse', label: 'Aminu Kano Crescent, Wuse 2', lat: 9.0765, lng: 7.4820 },
  { state: 'FCT Abuja', keyword: 'garki', label: 'Area 11, Garki', lat: 9.0333, lng: 7.4833 },
  { state: 'FCT Abuja', keyword: 'maitama', label: 'Maitama District, Abuja', lat: 9.0882, lng: 7.4934 },
  { state: 'Kano', keyword: 'sabon gari', label: 'Sabon Gari Market, Kano', lat: 12.0124, lng: 8.5326 },
  { state: 'Kano', keyword: 'nassarawa', label: 'Nassarawa GRA, Kano', lat: 11.9912, lng: 8.5458 },
  { state: 'Oyo', keyword: 'ring road', label: 'Ring Road, Ibadan', lat: 7.3621, lng: 3.8685 },
  { state: 'Oyo', keyword: 'bodija', label: 'Bodija Estate, Ibadan', lat: 7.4239, lng: 3.9082 },
  { state: 'Rivers', keyword: 'gra', label: 'New GRA, Port Harcourt', lat: 4.8242, lng: 7.0011 },
  { state: 'Kaduna', keyword: 'barnawa', label: 'Barnawa, Kaduna', lat: 10.4833, lng: 7.4333 },
];

export function getLandmarksForState(stateName: string): Array<{ label: string; state: string }> {
  const normalizedState = stateName.trim().toLowerCase();
  const stateMatches = LANDMARK_COORDS.filter(
    (l) => l.state.toLowerCase() === normalizedState
  ).map((l) => ({ label: l.label, state: l.state }));

  if (stateMatches.length > 0) {
    return stateMatches;
  }
  const hub = findStateHub(stateName);
  return [
    { label: `${hub.capital} Central Hub`, state: hub.name },
    { label: `${hub.capital} Main Market`, state: hub.name },
    { label: `${hub.capital} GRA`, state: hub.name },
  ];
}

export function findNearestPlaceFromCoords(lat: number, lng: number): { state: string; address: string } {
  let bestState = NIGERIA_STATES[0].name;
  let bestDist = Infinity;
  let bestAddress = '';

  for (const lm of LANDMARK_COORDS) {
    const d = Math.hypot(lat - lm.lat, lng - lm.lng);
    if (d < bestDist) {
      bestDist = d;
      bestState = lm.state;
      bestAddress = lm.label;
    }
  }
  for (const st of NIGERIA_STATES) {
    const d = Math.hypot(lat - st.lat, lng - st.lng);
    if (d < bestDist) {
      bestDist = d;
      bestState = st.name;
      bestAddress = `${st.capital} Central`;
    }
  }
  return { state: bestState, address: bestAddress || `${bestState} Hub` };
}

/**
 * Resolves realistic coordinates within a Nigerian state, matching known landmarks first
 * and falling back to deterministic street-level jitter around the state capital.
 */
export function resolveAddressCoordinates(stateName: string, address: string): { lat: number; lng: number } {
  const normalizedState = stateName.trim().toLowerCase();
  const normalizedAddr = address.trim().toLowerCase();

  for (const lm of LANDMARK_COORDS) {
    if (lm.state.toLowerCase() === normalizedState && normalizedAddr.includes(lm.keyword)) {
      return { lat: lm.lat, lng: lm.lng };
    }
  }

  const hub = findStateHub(stateName);
  let hash = 0;
  const clean = `${stateName}:${address}`.trim().toLowerCase();
  for (let i = 0; i < clean.length; i++) {
    hash = (hash * 31 + clean.charCodeAt(i)) | 0;
  }
  const latOffset = ((hash % 1000) / 1000 - 0.5) * 0.14;
  const lngOffset = ((((hash >> 8) % 1000) / 1000) - 0.5) * 0.14;
  return {
    lat: Number((hub.lat + latOffset).toFixed(5)),
    lng: Number((hub.lng + lngOffset).toFixed(5)),
  };
}
