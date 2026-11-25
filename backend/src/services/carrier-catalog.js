'use strict';
// Real carriers, by home country, with their PUBLIC tracking-page patterns ({id} = tracking number). Tariffs are NOT included:
// they depend on your contract — a carrier added from here starts switched OFF and is switched on only after you enter its price
// (otherwise routing would happily pick a "free" carrier and ship every order at zero cost).
const C = (id, name, home, tracking, countries = '', note = '') => ({ id, name, home, tracking, countries, note });
const CATALOG = [
  // Poland
  C('inpost', 'InPost (Paczkomaty, kurier)', 'PL', 'https://inpost.pl/sledzenie-przesylek?number={id}', 'PL', 'Самый популярный способ в Польше: паккоматы 24/7.'),
  C('dpd_pl', 'DPD Polska', 'PL', 'https://tracktrace.dpd.com.pl/parcelDetails?p1={id}'),
  C('dhl_parcel_pl', 'DHL Parcel Polska', 'PL', 'https://www.dhl.com/pl-pl/home/sledzenie.html?tracking-id={id}'),
  C('poczta_polska', 'Poczta Polska / Pocztex', 'PL', 'https://emonitoring.poczta-polska.pl/?numer={id}'),
  C('gls_pl', 'GLS Poland', 'PL', 'https://gls-group.com/PL/pl/sledzenie-paczek?match={id}'),
  C('orlen_paczka', 'ORLEN Paczka', 'PL', 'https://www.orlenpaczka.pl/sledz-paczke/?numer={id}', 'PL'),
  // international express
  C('dhl_express', 'DHL Express', 'INT', 'https://www.dhl.com/global-en/home/tracking/tracking-express.html?submit=1&tracking-id={id}', '', 'Экспресс по всему миру.'),
  C('ups', 'UPS', 'INT', 'https://www.ups.com/track?tracknum={id}'),
  C('fedex', 'FedEx', 'INT', 'https://www.fedex.com/fedextrack/?trknbr={id}'),
  C('gls_eu', 'GLS (Европа)', 'INT', 'https://gls-group.com/EU/en/parcel-tracking?match={id}'),
  C('dpd_eu', 'DPD (Европа)', 'INT', 'https://www.dpd.com/tracking/?parcelNumber={id}'),
  // Germany / Austria / Switzerland
  C('dhl_de', 'DHL Paket (Deutschland)', 'DE', 'https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode={id}'),
  C('hermes_de', 'Hermes Germany', 'DE', 'https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation#{id}', 'DE'),
  C('post_at', 'Österreichische Post', 'AT', 'https://www.post.at/s/sendungssuche?snr={id}'),
  C('swiss_post', 'Swiss Post', 'CH', 'https://service.post.ch/ekp-web/ui/entry/search/{id}'),
  // Czechia / Slovakia / Baltics
  C('packeta', 'Packeta (Zásilkovna)', 'CZ', 'https://tracking.packeta.com/en/?id={id}', '', 'Пункты выдачи в CZ, SK, PL, HU, RO и др.'),
  C('ceska_posta', 'Česká pošta', 'CZ', 'https://www.postaonline.cz/trackandtrace/-/zasilka/cislo?parcelNumbers={id}'),
  C('omniva', 'Omniva', 'EE', 'https://www.omniva.ee/private/track_and_trace?barcode={id}', 'EE,LV,LT', 'Паккоматы в Эстонии, Латвии, Литве.'),
  // France / Benelux
  C('colissimo', 'Colissimo (La Poste)', 'FR', 'https://www.laposte.fr/outils/suivre-vos-envois?code={id}'),
  C('chronopost', 'Chronopost', 'FR', 'https://www.chronopost.fr/tracking-no-cms/suivi-page?listeNumerosLT={id}'),
  C('postnl', 'PostNL', 'NL', 'https://jouw.postnl.nl/track-and-trace/{id}'),
  C('bpost', 'bpost', 'BE', 'https://track.bpost.cloud/btr/web/#/search?itemCode={id}'),
  // South
  C('correos', 'Correos', 'ES', 'https://www.correos.es/es/es/herramientas/localizador/envios/detalle?tracking-number={id}'),
  C('poste_it', 'Poste Italiane', 'IT', 'https://www.poste.it/cerca/index.html#/risultati-spedizioni/{id}'),
  C('ctt', 'CTT Correios', 'PT', 'https://www.ctt.pt/feapl_2/app/open/objectSearch/objectSearch.jspx?objects={id}'),
  // UK / Ireland
  C('royal_mail', 'Royal Mail', 'GB', 'https://www.royalmail.com/track-your-item#/tracking-results/{id}'),
  C('evri', 'Evri', 'GB', 'https://www.evri.com/track/parcel/{id}', 'GB'),
  C('an_post', 'An Post', 'IE', 'https://www.anpost.com/Post-Parcels/Track/History?item={id}'),
  // Ukraine / North America
  C('nova_poshta', 'Нова Пошта', 'UA', 'https://novaposhta.ua/tracking/?cargo_number={id}', '', 'Также доставка из Польши в Украину.'),
  C('ukrposhta', 'Укрпошта', 'UA', 'https://track.ukrposhta.ua/tracking_UA.html?barcode={id}'),
  C('usps', 'USPS', 'US', 'https://tools.usps.com/go/TrackConfirmAction?tLabels={id}'),
  C('canada_post', 'Canada Post', 'CA', 'https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor={id}')
];
// destination countries the setup page checks coverage for
const EU = ['PL', 'DE', 'CZ', 'SK', 'LT', 'LV', 'EE', 'AT', 'HU', 'RO', 'BG', 'FR', 'NL', 'BE', 'LU', 'IT', 'ES', 'PT', 'IE', 'DK', 'SE', 'FI', 'GR', 'HR', 'SI', 'CY', 'MT'];
const OTHER = ['GB', 'CH', 'NO', 'UA', 'US', 'CA'];
module.exports = { CATALOG, EU, OTHER, byId: id => CATALOG.find(c => c.id === id) || null };
