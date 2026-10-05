import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';

/** Set the document title and move focus to the page heading on navigation. */
export function usePageTitle(title: string) {
  useEffect(() => {
    document.title = `${title} — OpenRampart`;
  }, [title]);
}

export function useFocusMainOnNavigate() {
  const location = useLocation();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const h1 = document.querySelector('main h1') as HTMLElement | null;
    if (h1) {
      h1.setAttribute('tabindex', '-1');
      h1.focus({ preventScroll: false });
    }
  }, [location.pathname]);
}
