/** The LearnSDLC mark: a laptop and a graduation cap. */
export function Mark({
  size = 22,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <img
      src="/artwork/learnsdlc-laptop-cap.svg"
      width={size}
      height={size}
      alt=""
      aria-hidden
      className={`shrink-0 ${className}`}
    />
  );
}
