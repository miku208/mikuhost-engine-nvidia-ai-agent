import React from 'react';

/**
 * The UI is written without a JSX build step so that `npm link` + `mikuhost`
 * works immediately (no bundler, no loader flags). `h` is createElement.
 */
export const h = React.createElement;
export const Fragment = React.Fragment;
