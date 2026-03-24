export const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];

export const RTC_CONFIG = {
  iceServers: STUN_SERVERS,
  iceCandidatePoolSize: 10,
};

export const MAX_CHAT_MESSAGES = 100;
export const RECONNECT_ATTEMPTS = 3;

export const LANGUAGE_FACTS = [
  'There are over 7,000 languages spoken worldwide today.',
  'Mandarin Chinese has the most native speakers in the world.',
  'Papua New Guinea has over 840 living languages!',
  'The Bible is the most translated book in history.',
  'Hindi is understood by about 600 million people worldwide.',
  'Korean was invented by a single person — King Sejong.',
  'Tamil is one of the oldest living languages, over 5,000 years old.',
  'Spanish is the official language of 20 countries.',
  'Japanese uses three different writing systems.',
  'Arabic is written from right to left.',
  'The most common letter in English is "E".',
  'Basque is a language isolate — unrelated to any other language.',
  'There are about 22 official languages in India.',
  'Esperanto was created in 1887 as a universal language.',
  'Khmer has the longest alphabet with 74 letters.',
  'Sign languages vary by country — they\'re not universal.',
  'Icelandic has changed very little in 1,000 years.',
  'South Africa has 11 official languages.',
  'The word "alphabet" comes from alpha + beta (Greek).',
  'About 40% of the world\'s languages are endangered.',
];
