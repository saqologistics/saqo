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

export interface LandmarkPlace {
  state: string;
  keyword: string;
  label: string;
  lat: number;
  lng: number;
  category?: 'Gate' | 'Street' | 'Area' | 'Market' | 'Campus' | 'Hospital' | 'Hub' | 'LGA';
  aliases?: string[];
}

export interface AddressSuggestion {
  label: string;
  state: string;
  lat: number;
  lng: number;
  category?: string;
  subtitle?: string;
  source?: 'directory' | 'live' | 'gps';
}

const LANDMARK_COORDS: LandmarkPlace[] = [
  // Katsina Metropolis — Historic Gates (Kofofi) & Central Landmarks
  {
    state: 'Katsina',
    keyword: 'kofar kaura',
    label: 'Kofar Kaura, Katsina',
    lat: 12.9818,
    lng: 7.6122,
    category: 'Gate',
    aliases: ['kaura gate', 'k/kaura', 'kaura', 'motor park'],
  },
  {
    state: 'Katsina',
    keyword: 'batagarawa',
    label: 'Batagarawa, Katsina',
    lat: 12.9056,
    lng: 7.6011,
    category: 'LGA',
    aliases: ['batagarawa lga', 'tsanni'],
  },
  {
    state: 'Katsina',
    keyword: 'kofar marusa',
    label: 'Kofar Marusa, Katsina',
    lat: 12.9762,
    lng: 7.6245,
    category: 'Gate',
    aliases: ['marusa', 'k/marusa', 'marusa roundabout'],
  },
  {
    state: 'Katsina',
    keyword: 'gra',
    label: 'GRA, Katsina',
    lat: 12.9715,
    lng: 7.6085,
    category: 'Area',
    aliases: ['government reserved area', 'kt gra', 'katsina gra'],
  },
  {
    state: 'Katsina',
    keyword: 'sabon layi',
    label: 'Sabon Layi, Katsina',
    lat: 12.9891,
    lng: 7.5994,
    category: 'Area',
    aliases: ['sabon layi quarters', 'sabon'],
  },
  {
    state: 'Katsina',
    keyword: 'kofar sauri',
    label: 'Kofar Sauri, Katsina',
    lat: 12.9964,
    lng: 7.5982,
    category: 'Gate',
    aliases: ['sauri', 'k/sauri'],
  },
  {
    state: 'Katsina',
    keyword: 'kofar guga',
    label: 'Kofar Guga, Katsina',
    lat: 12.9905,
    lng: 7.6028,
    category: 'Gate',
    aliases: ['guga', 'k/guga'],
  },
  {
    state: 'Katsina',
    keyword: 'kofar kwaya',
    label: 'Kofar Kwaya, Katsina',
    lat: 12.9840,
    lng: 7.6050,
    category: 'Gate',
    aliases: ['kwaya', 'k/kwaya'],
  },
  {
    state: 'Katsina',
    keyword: 'kofar yandaka',
    label: 'Kofar Yandaka, Katsina',
    lat: 12.9875,
    lng: 7.5945,
    category: 'Gate',
    aliases: ['yandaka', 'k/yandaka'],
  },
  {
    state: 'Katsina',
    keyword: 'kofar durbi',
    label: 'Kofar Durbi, Katsina',
    lat: 12.9862,
    lng: 7.6215,
    category: 'Gate',
    aliases: ['durbi', 'k/durbi'],
  },
  {
    state: 'Katsina',
    keyword: 'kofar bai',
    label: 'Kofar Bai, Katsina',
    lat: 12.9922,
    lng: 7.6118,
    category: 'Gate',
    aliases: ['bai', 'k/bai'],
  },
  {
    state: 'Katsina',
    keyword: 'kofar soro',
    label: "Kofar Soro (Emir's Palace), Katsina",
    lat: 12.9895,
    lng: 7.6068,
    category: 'Hub',
    aliases: ['emir palace', 'soro', 'fada', 'gobarau'],
  },
  // Katsina Metropolis — Markets, Roads, Estates, Campuses & Hospitals
  {
    state: 'Katsina',
    keyword: 'central market',
    label: 'Katsina Central Market (Kasuwa)',
    lat: 12.9852,
    lng: 7.6130,
    category: 'Market',
    aliases: ['kasuwa', 'kasuwar katsina', 'babbar kasuwa', 'market'],
  },
  {
    state: 'Katsina',
    keyword: 'ibb way',
    label: 'IBB Way, Katsina',
    lat: 12.9765,
    lng: 7.6045,
    category: 'Street',
    aliases: ['ibrahim babangida way', 'ibb'],
  },
  {
    state: 'Katsina',
    keyword: 'yahaya madaki',
    label: 'Yahaya Madaki Way, Katsina',
    lat: 12.9802,
    lng: 7.6082,
    category: 'Street',
    aliases: ['madaki way', 'kiddies'],
  },
  {
    state: 'Katsina',
    keyword: 'nagogo road',
    label: 'Nagogo Road, Katsina',
    lat: 12.9748,
    lng: 7.6115,
    category: 'Street',
    aliases: ['nagogo', 'alhaji nagogo'],
  },
  {
    state: 'Katsina',
    keyword: 'goruba road',
    label: 'Goruba Road / Federal Secretariat, Katsina',
    lat: 12.9690,
    lng: 7.5960,
    category: 'Street',
    aliases: ['goruba', 'secretariat', 'federal secretariat'],
  },
  {
    state: 'Katsina',
    keyword: 'kiddies roundabout',
    label: 'Kiddies Roundabout, Katsina',
    lat: 12.9785,
    lng: 7.6098,
    category: 'Hub',
    aliases: ['kiddies', 'roundabout'],
  },
  {
    state: 'Katsina',
    keyword: 'umyu',
    label: "Umaru Musa Yar'adua University (UMYU), Katsina",
    lat: 12.8886,
    lng: 7.5714,
    category: 'Campus',
    aliases: ['yaradua university', 'umyu campus', 'dutsinma road university'],
  },
  {
    state: 'Katsina',
    keyword: 'huk poly',
    label: 'Hassan Usman Katsina Polytechnic (HUK Poly)',
    lat: 12.9488,
    lng: 7.6112,
    category: 'Campus',
    aliases: ['polytechnic', 'huk', 'katsina poly'],
  },
  {
    state: 'Katsina',
    keyword: 'al-qalam',
    label: 'Al-Qalam University, Dutsin-Ma Road, Katsina',
    lat: 12.9410,
    lng: 7.6085,
    category: 'Campus',
    aliases: ['auk', 'alqalam', 'al qalam'],
  },
  {
    state: 'Katsina',
    keyword: 'fmc katsina',
    label: 'Federal Medical Centre (FMC), Katsina',
    lat: 12.9612,
    lng: 7.6265,
    category: 'Hospital',
    aliases: ['fmc', 'federal medical center', 'federal teaching hospital'],
  },
  {
    state: 'Katsina',
    keyword: 'general hospital',
    label: 'General Hospital, Katsina',
    lat: 12.9868,
    lng: 7.6162,
    category: 'Hospital',
    aliases: ['hospital', 'asibiti'],
  },
  {
    state: 'Katsina',
    keyword: 'karkanda stadium',
    label: 'Muhammadu Dikko (Karkanda) Stadium, Katsina',
    lat: 12.9685,
    lng: 7.6295,
    category: 'Hub',
    aliases: ['stadium', 'dikko stadium', 'karkanda'],
  },
  {
    state: 'Katsina',
    keyword: 'airport',
    label: "Umaru Musa Yar'adua Airport, Katsina",
    lat: 13.0078,
    lng: 7.6602,
    category: 'Hub',
    aliases: ['katsina airport', 'tashar jirgi'],
  },
  {
    state: 'Katsina',
    keyword: 'tudun wada',
    label: 'Tudun Wada, Katsina',
    lat: 12.9795,
    lng: 7.5940,
    category: 'Area',
    aliases: ['tudun wada quarters'],
  },
  {
    state: 'Katsina',
    keyword: 'saulawa',
    label: 'Saulawa, Katsina',
    lat: 12.9912,
    lng: 7.6010,
    category: 'Area',
    aliases: ['saulawa quarters'],
  },
  {
    state: 'Katsina',
    keyword: 'rafindadi',
    label: 'Rafindadi, Katsina',
    lat: 12.9885,
    lng: 7.6095,
    category: 'Area',
    aliases: ['rafin dadi'],
  },
  {
    state: 'Katsina',
    keyword: 'filin samji',
    label: 'Filin Samji, Katsina',
    lat: 12.9825,
    lng: 7.6190,
    category: 'Area',
    aliases: ['samji', 'filin'],
  },
  {
    state: 'Katsina',
    keyword: 'shinkafi',
    label: 'Shinkafi, Katsina',
    lat: 12.9780,
    lng: 7.6380,
    category: 'Area',
    aliases: ['shinkafi layout'],
  },
  {
    state: 'Katsina',
    keyword: 'kambarawa',
    label: 'Kambarawa, Katsina',
    lat: 12.9640,
    lng: 7.6350,
    category: 'Area',
    aliases: ['kambarawa quarters'],
  },
  {
    state: 'Katsina',
    keyword: 'sabuwar unguwa',
    label: 'Sabuwar Unguwa / Layout, Katsina',
    lat: 12.9730,
    lng: 7.6210,
    category: 'Area',
    aliases: ['layout', 'kofar kaura layout', 'new layout'],
  },
  {
    state: 'Katsina',
    keyword: 'kerau',
    label: 'Kerau, Katsina',
    lat: 12.9935,
    lng: 7.6165,
    category: 'Area',
    aliases: ['kerau quarters'],
  },
  {
    state: 'Katsina',
    keyword: 'barhim',
    label: 'Barhim Estate / Modoji, Katsina',
    lat: 12.9565,
    lng: 7.6020,
    category: 'Area',
    aliases: ['barhim estate', 'modoji', 'housing estate'],
  },
  {
    state: 'Katsina',
    keyword: 'dutsin safe',
    label: 'Dutsin Safe Low-Cost, Katsina',
    lat: 12.9630,
    lng: 7.6135,
    category: 'Area',
    aliases: ['low cost', 'dutsin safe'],
  },
  {
    state: 'Katsina',
    keyword: 'tayoyi',
    label: 'Tayoyi, Katsina',
    lat: 12.9800,
    lng: 7.6285,
    category: 'Area',
    aliases: ['tayoyi layout'],
  },
  {
    state: 'Katsina',
    keyword: 'darma',
    label: 'Darma, Katsina',
    lat: 12.9950,
    lng: 7.6060,
    category: 'Area',
    aliases: ['darma quarters'],
  },
  {
    state: 'Katsina',
    keyword: 'steel rolling',
    label: 'Katsina Steel Rolling / Industrial Layout',
    lat: 12.9520,
    lng: 7.6480,
    category: 'Hub',
    aliases: ['industrial layout', 'rolling mill'],
  },
  {
    state: 'Katsina',
    keyword: 'katsina central',
    label: 'Katsina Central Hub',
    lat: 12.9816,
    lng: 7.6223,
    category: 'Hub',
    aliases: ['katsina city', 'katsina town'],
  },
  // Katsina State Major LGAs & Towns
  {
    state: 'Katsina',
    keyword: 'dutsin-ma',
    label: 'Dutsin-Ma (FUDMA / Town), Katsina',
    lat: 12.4539,
    lng: 7.4972,
    category: 'LGA',
    aliases: ['dutsinma', 'dutsin ma', 'fudma', 'dutsin-ma road'],
  },
  {
    state: 'Katsina',
    keyword: 'daura',
    label: 'Daura Town, Katsina',
    lat: 13.0358,
    lng: 8.3189,
    category: 'LGA',
    aliases: ['daura lga', 'daura emirate'],
  },
  {
    state: 'Katsina',
    keyword: 'funtua',
    label: 'Funtua Town, Katsina',
    lat: 11.5235,
    lng: 7.3117,
    category: 'LGA',
    aliases: ['funtua lga', 'funtua market'],
  },
  {
    state: 'Katsina',
    keyword: 'malumfashi',
    label: 'Malumfashi Town, Katsina',
    lat: 11.7894,
    lng: 7.6206,
    category: 'LGA',
    aliases: ['malumfashi lga'],
  },
  {
    state: 'Katsina',
    keyword: 'kankia',
    label: 'Kankia Town, Katsina',
    lat: 12.5469,
    lng: 7.8226,
    category: 'LGA',
    aliases: ['kankia lga'],
  },
  {
    state: 'Katsina',
    keyword: 'jibia',
    label: 'Jibia Town, Katsina',
    lat: 13.0933,
    lng: 7.2261,
    category: 'LGA',
    aliases: ['jibiya', 'jibia border'],
  },
  {
    state: 'Katsina',
    keyword: 'bakori',
    label: 'Bakori Town, Katsina',
    lat: 11.5546,
    lng: 7.4241,
    category: 'LGA',
    aliases: ['bakori lga'],
  },
  {
    state: 'Katsina',
    keyword: 'mani',
    label: 'Mani Town, Katsina',
    lat: 12.8543,
    lng: 7.8753,
    category: 'LGA',
    aliases: ['mani lga'],
  },
  {
    state: 'Katsina',
    keyword: 'mashi',
    label: 'Mashi Town, Katsina',
    lat: 12.9804,
    lng: 7.9470,
    category: 'LGA',
    aliases: ['mashi lga'],
  },
  {
    state: 'Katsina',
    keyword: 'kaita',
    label: 'Kaita Town, Katsina',
    lat: 13.0819,
    lng: 7.7422,
    category: 'LGA',
    aliases: ['kaita lga'],
  },
  {
    state: 'Katsina',
    keyword: 'rimi',
    label: 'Rimi Town, Katsina',
    lat: 12.8505,
    lng: 7.7097,
    category: 'LGA',
    aliases: ['rimi lga'],
  },
  {
    state: 'Katsina',
    keyword: 'charanchi',
    label: 'Charanchi Town, Katsina',
    lat: 12.6716,
    lng: 7.7294,
    category: 'LGA',
    aliases: ['charanchi lga'],
  },
  {
    state: 'Katsina',
    keyword: 'kurfi',
    label: 'Kurfi Town, Katsina',
    lat: 12.6672,
    lng: 7.4847,
    category: 'LGA',
    aliases: ['kurfi lga'],
  },
  {
    state: 'Katsina',
    keyword: 'kankara',
    label: 'Kankara Town, Katsina',
    lat: 11.9317,
    lng: 7.4125,
    category: 'LGA',
    aliases: ['kankara lga'],
  },
  {
    state: 'Katsina',
    keyword: 'batsari',
    label: 'Batsari Town, Katsina',
    lat: 12.7556,
    lng: 7.2478,
    category: 'LGA',
    aliases: ['batsari lga'],
  },
  {
    state: 'Katsina',
    keyword: 'ingawa',
    label: 'Ingawa Town, Katsina',
    lat: 12.6414,
    lng: 8.0517,
    category: 'LGA',
    aliases: ['ingawa lga'],
  },
  // Other Nigerian State Hubs (for future / test compatibility)
  { state: 'Lagos', keyword: 'victoria island', label: 'Adeola Odeku, Victoria Island', lat: 6.4281, lng: 3.4219, category: 'Area' },
  { state: 'Lagos', keyword: 'lekki', label: 'Admiralty Way, Lekki Phase 1', lat: 6.4474, lng: 3.4723, category: 'Street' },
  { state: 'Lagos', keyword: 'ikeja', label: 'Allen Avenue, Ikeja', lat: 6.6018, lng: 3.3515, category: 'Street' },
  { state: 'Lagos', keyword: 'ikoyi', label: 'Bourdillon Road, Ikoyi', lat: 6.4549, lng: 3.4346, category: 'Street' },
  { state: 'Lagos', keyword: 'surulere', label: 'Adeniran Ogunsanya, Surulere', lat: 6.4969, lng: 3.3612, category: 'Area' },
  { state: 'FCT Abuja', keyword: 'wuse', label: 'Aminu Kano Crescent, Wuse 2', lat: 9.0765, lng: 7.4820, category: 'Street' },
  { state: 'FCT Abuja', keyword: 'garki', label: 'Area 11, Garki', lat: 9.0333, lng: 7.4833, category: 'Area' },
  { state: 'FCT Abuja', keyword: 'maitama', label: 'Maitama District, Abuja', lat: 9.0882, lng: 7.4934, category: 'Area' },
  { state: 'Kano', keyword: 'sabon gari', label: 'Sabon Gari Market, Kano', lat: 12.0124, lng: 8.5326, category: 'Market' },
  { state: 'Kano', keyword: 'nassarawa', label: 'Nassarawa GRA, Kano', lat: 11.9912, lng: 8.5458, category: 'Area' },
  { state: 'Oyo', keyword: 'ring road', label: 'Ring Road, Ibadan', lat: 7.3621, lng: 3.8685, category: 'Street' },
  { state: 'Oyo', keyword: 'bodija', label: 'Bodija Estate, Ibadan', lat: 7.4239, lng: 3.9082, category: 'Area' },
  { state: 'Rivers', keyword: 'gra', label: 'New GRA, Port Harcourt', lat: 4.8242, lng: 7.0011, category: 'Area' },
  { state: 'Kaduna', keyword: 'barnawa', label: 'Barnawa, Kaduna', lat: 10.4833, lng: 7.4333, category: 'Area' },
];

export function getLandmarksForState(stateName: string): AddressSuggestion[] {
  const normalizedState = stateName.trim().toLowerCase();
  const stateMatches = LANDMARK_COORDS.filter(
    (l) => l.state.toLowerCase() === normalizedState
  ).map((l) => ({
    label: l.label,
    state: l.state,
    lat: l.lat,
    lng: l.lng,
    category: l.category,
    source: 'directory' as const,
  }));

  if (stateMatches.length > 0) {
    return stateMatches;
  }
  const hub = findStateHub(stateName);
  return [
    { label: `${hub.capital} Central Hub`, state: hub.name, lat: hub.lat, lng: hub.lng, category: 'Hub', source: 'directory' },
  ];
}

function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function searchSmartAddresses(
  stateName: string,
  query: string,
  excludeLabel?: string
): AddressSuggestion[] {
  const normalizedState = stateName.trim().toLowerCase();
  const stateEntries = LANDMARK_COORDS.filter(
    (l) => l.state.toLowerCase() === normalizedState
  );

  const baseEntries: LandmarkPlace[] =
    stateEntries.length > 0
      ? stateEntries
      : getLandmarksForState(stateName).map((s) => ({
          state: s.state,
          keyword: normalizeSearchText(s.label),
          label: s.label,
          lat: s.lat,
          lng: s.lng,
          category: 'Hub',
        }));

  const q = normalizeSearchText(query);
  const excluded = normalizeSearchText(excludeLabel || '');

  if (!q) {
    return baseEntries
      .filter((e) => !excluded || normalizeSearchText(e.label) !== excluded)
      .slice(0, 12)
      .map((l) => ({
        label: l.label,
        state: l.state,
        lat: l.lat,
        lng: l.lng,
        category: l.category,
        source: 'directory' as const,
      }));
  }

  const tokens = q.split(' ').filter(Boolean);

  const scored = baseEntries
    .map((entry) => {
      const normLabel = normalizeSearchText(entry.label);
      const normKeyword = normalizeSearchText(entry.keyword);
      const normAliases = (entry.aliases || []).map(normalizeSearchText);
      const normCategory = normalizeSearchText(entry.category || '');
      const haystack = [normLabel, normKeyword, ...normAliases, normCategory].join(' ');

      let score = 0;
      if (normLabel === q || normKeyword === q || normAliases.includes(q)) {
        score += 120;
      } else if (normLabel.startsWith(q) || normKeyword.startsWith(q)) {
        score += 90;
      } else if (normAliases.some((a) => a.startsWith(q))) {
        score += 85;
      } else if (normLabel.includes(q) || normKeyword.includes(q) || normAliases.some((a) => a.includes(q))) {
        score += 65;
      } else if (tokens.every((token) => haystack.split(/[ -]+/).some((word) => word.startsWith(token)))) {
        score += 50;
      }

      if (excluded && normLabel === excluded) score = 0;

      return { entry, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored.slice(0, 10).map(({ entry }) => ({
    label: entry.label,
    state: entry.state,
    lat: entry.lat,
    lng: entry.lng,
    category: entry.category,
    source: 'directory' as const,
  }));
}

export function findNearestPlaceFromCoords(
  lat: number,
  lng: number
): { state: string; address: string; lat: number; lng: number } {
  let bestState = NIGERIA_STATES[0].name;
  let bestDist = Infinity;
  let bestAddress = '';
  let bestLat = lat;
  let bestLng = lng;

  for (const lm of LANDMARK_COORDS) {
    const d = Math.hypot(lat - lm.lat, lng - lm.lng);
    if (d < bestDist) {
      bestDist = d;
      bestState = lm.state;
      bestAddress = lm.label;
      bestLat = lm.lat;
      bestLng = lm.lng;
    }
  }
  for (const st of NIGERIA_STATES) {
    const d = Math.hypot(lat - st.lat, lng - st.lng);
    if (d < bestDist) {
      bestDist = d;
      bestState = st.name;
      bestAddress = `${st.capital} Central`;
      bestLat = st.lat;
      bestLng = st.lng;
    }
  }
  return {
    state: bestState,
    address: bestAddress || `${bestState} Hub`,
    lat: bestLat,
    lng: bestLng,
  };
}

/** Returns coordinates only for a known, unambiguous directory entry. */
export function resolveAddressCoordinates(
  stateName: string,
  address: string
): { lat: number; lng: number } | null {
  const state = normalizeSearchText(stateName);
  const query = normalizeSearchText(address);
  if (!query) return null;

  const entries = LANDMARK_COORDS.filter((place) => normalizeSearchText(place.state) === state);
  const exactLabel = entries.find((place) => normalizeSearchText(place.label) === query);
  if (exactLabel) return { lat: exactLabel.lat, lng: exactLabel.lng };

  const aliases = entries.filter((place) =>
    [place.keyword, ...(place.aliases || [])].some((alias) => normalizeSearchText(alias) === query)
  );
  if (aliases.length !== 1) return null;
  return { lat: aliases[0].lat, lng: aliases[0].lng };
}
