import './experience.css';

export const AVATAR_LABELS = [
  'Curly crop and glasses',
  'Wavy bob',
  'High bun',
  'Silver waves',
  'Swept locs and beard',
  'Pixie cut',
] as const;

export function LearnerAvatar({
  avatar = 0,
  size = 80,
}: {
  avatar?: number;
  size?: number;
}) {
  const selected =
    Number.isInteger(avatar) && avatar >= 0 && avatar < 6 ? avatar : 0;
  return (
    <span
      className="exp-avatar"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        backgroundPosition: `${(selected % 3) * 50}% ${Math.floor(selected / 3) * 100}%`,
      }}
    />
  );
}
