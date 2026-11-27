import { useEffect, useState } from 'react';
import { PHONE_QUERY } from './breakpoints.ts';

export { PHONE_QUERY };

/** True below 640 px, following the window as it resizes. */
export function usePhone(): boolean {
  const [phone, setPhone] = useState(() => window.matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(PHONE_QUERY);
    const update = () => setPhone(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return phone;
}
