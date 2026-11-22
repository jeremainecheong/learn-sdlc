/**
 * Passwords that appear near the top of every public credential dump
 * (rockyou and the HIBP/NCSC orderings that followed it). An attacker's first
 * few hundred guesses against a fresh account are these, in roughly this
 * order, so refusing them removes the cheapest attack there is.
 *
 * Everything here is at least 8 characters: RegisterDto already refuses
 * anything shorter, so listing "abc123" would only pad the file. The list is
 * deliberately small enough to sit in memory: a complete breach corpus means
 * a network call on the registration path, and a check that can time out is a
 * check that gets skipped.
 */
const ENTRIES = [
  '12345678', '123456789', '1234567890', '1234567891', '12345678910', '123456789a', '1234512345',
  '12341234', '123456123', '11111111', '111111111', '00000000', '000000000', '22222222', '33333333',
  '44444444', '55555555', '66666666', '77777777', '88888888', '99999999', '121212121', '123123123',
  '112233445', '123321123', '147258369', '741852963', '987654321', '9876543210', '102030405',
  '11223344', '10203040', '12345679', '1234567a',

  '1q2w3e4r', '1q2w3e4r5t', 'q1w2e3r4', 'q1w2e3r4t5', '1qaz2wsx', '1qaz2wsx3edc', 'zaq12wsx',
  '2wsx3edc', 'qwertyui', 'qwertyuiop', 'qwerty12', 'qwerty123', 'qwerty1234', 'qwerty12345',
  'asdfghjkl', 'asdfghjk', 'asdfasdf', 'asdf1234', 'asdasdasd', 'zxcvbnm1', 'zxcvbnm123',
  '1234qwer', 'qwer1234', 'qweasdzxc', 'qazwsxedc', 'qazxswedc', 'qweqweqwe', '123qweasd',
  'azerty123', 'qwertz123', 'poiuytrewq', 'lkjhgfdsa', 'mnbvcxz1',

  'password', 'password1', 'password2', 'password3', 'password7', 'password9', 'password11',
  'password12', 'password01', 'password123', 'password1234', 'password12345', 'password123456',
  'passwords', 'password!', 'password@', 'password@123', 'passw0rd', 'passw0rd1', 'passw0rd123',
  'passw0rd!', 'p@ssword', 'p@ssword1', 'p@ssw0rd', 'p@ssw0rd1', 'p@ssw0rd!', 'pa55word',
  'pass1234', 'pass12345', 'passpass', 'mypassword', 'newpassword', 'passwort', 'motdepasse',

  'welcome1', 'welcome12', 'welcome123', 'welcome1234', 'welcome@123', 'admin123', 'admin1234',
  'admin12345', 'admin@123', 'adminadmin', 'administrator', 'changeme', 'changeme1', 'changeme123',
  'letmein1', 'letmein12', 'letmein123', 'secret123', 'testtest', 'test1234', 'test12345',
  'testing123', 'temp1234', 'guest123', 'root1234', 'oracle123', 'default123', 'sysadmin1',
  'qwerty@123', 'abcd@1234', 'india@123', 'india123',

  'abc12345', 'abc123456', 'abcd1234', 'abcd12345', 'abcdefgh', 'abcdefg1', 'a1b2c3d4', 'a1b2c3d4e5',
  '1a2b3c4d', 'aaaaaaaa', 'zzzzzzzz', 'qqqqqqqq', 'blahblah', 'whatever', 'whatever1', 'trustno1',
  'freedom1', 'freedom123', 'iloveyou', 'iloveyou1', 'iloveyou2', 'iloveyou123', 'lovelove',
  'loveme123', 'beautiful', 'gorgeous', 'sweetheart', 'babygirl', 'babygirl1', 'blessed1',

  'princess', 'princess1', 'princesa', 'sunshine', 'sunshine1', 'sunshine123', 'sunflower',
  'rainbow1', 'rainbow123', 'butterfly', 'butterfly1', 'chocolate', 'chocolate1', 'cheese123',
  'happy123', 'hello123', 'helloworld', 'hellokitty', 'jesus123', 'jesuschrist', 'godislove',
  'dragon123', 'dragon12', 'monkey12', 'monkey123', 'shadow123', 'master123', 'masterkey',
  'diamond1', 'chicken1', 'money123', 'moneyman1',

  'michael1', 'michael123', 'michelle', 'jennifer', 'jonathan', 'samantha', 'danielle', 'elizabeth',
  'alexander', 'alexandra', 'alejandro', 'brittany', 'nicholas', 'benjamin', 'victoria', 'stephanie',
  'christian', 'christopher', 'jessica1', 'jordan23', 'jordan123', 'anthony1', 'matthew1',
  'charlie1', 'chelsea1', 'melissa1', 'patrick1', 'brandon1', 'jasmine1', 'veronica1', 'natasha1',

  'football', 'football1', 'football123', 'baseball', 'baseball1', 'basketball', 'basketball1',
  'softball', 'volleyball', 'liverpool', 'liverpool1', 'chelseafc', 'barcelona', 'realmadrid',
  'manchester', 'manutd123', 'juventus', 'arsenal1', 'ferrari1', 'corvette', 'mustang1', 'porsche1',
  'harley123', 'yamaha123', 'nascar123',

  'computer', 'computer1', 'internet', 'internet1', 'samsung1', 'iphone123', 'android1', 'facebook',
  'facebook1', 'instagram', 'instagram1', 'whatsapp', 'whatsapp1', 'twitter1', 'linkedin',
  'google123', 'youtube1', 'youtube123', 'microsoft', 'windows1', 'windows98',

  'starwars', 'starwars1', 'startrek', 'superman', 'superman1', 'spiderman', 'spiderman1',
  'batman123', 'wolverine', 'pokemon1', 'pokemon123', 'spongebob', 'tinkerbell', 'minecraft',
  'minecraft1', 'fortnite', 'fortnite1', 'callofduty', 'nintendo', 'metallica', 'nirvana1',
  'garfield', 'simpsons', 'slipknot',

  'summer123', 'winter123', 'spring123', 'autumn123', 'summer2020', 'summer2021', 'summer2022',
  'summer2023', 'summer2024', 'summer2025', 'winter2021', 'winter2022', 'winter2023', 'spring2021',
  'spring2022', 'spring2023', 'autumn2021', 'january1', 'february1', 'december1', 'november1',

  'fuckyou1', 'fuckyou2', 'fuckyou123', 'fuckoff1', 'asshole1', 'bullshit', 'bullshit1', 'bitches1',
];

const BLOCKED: ReadonlySet<string> = new Set(ENTRIES);

/**
 * Case-insensitive, and whitespace at the edges is trimmed first: "Password "
 * is the same guess an attacker is making, not a stronger secret.
 */
export function isCommonPassword(candidate: string): boolean {
  return BLOCKED.has(candidate.trim().toLowerCase());
}
