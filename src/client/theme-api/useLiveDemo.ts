import { useDemo } from 'dumi';
import throttle from 'lodash.throttle';
import {
  createElement,
  useCallback,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type RefObject,
} from 'react';
import DemoErrorBoundary from './DumiDemo/DemoErrorBoundary';
import type { AgnosticComponentType } from './types';
import { useRenderer } from './useRenderer';
import { getAgnosticComponentModule } from './utils';

const THROTTLE_WAIT = 500;

type CommonJSContext = {
  module: any;
  exports: {
    default?: any;
  };
  require: any;
};

function evalCommonJS(
  js: string,
  { module, exports, require }: CommonJSContext,
) {
  new Function('module', 'exports', 'require', js)(module, exports, require);
}

export const useLiveDemo = (
  id: string,
  opts?: { containerRef?: RefObject<HTMLElement>; iframe?: boolean },
) => {
  const demo = useDemo(id)!;
  const [loading, setLoading] = useState(false);
  const loadingTimer = useRef<number>();
  const taskToken = useRef<number>();

  function resetLoadingStatus() {
    clearTimeout(loadingTimer.current);
    setLoading(false);
  }

  const { context = {}, asset, renderOpts } = demo;
  const [error, setError] = useState<Error | null>(null);

  const { canvasRef: ref, setComponent } = useRenderer({
    id,
    renderOpts: demo.renderOpts,
    onResolved: () => {
      resetLoadingStatus();
    },
  });

  const [demoNode, setDemoNode] = useState<ReactNode>();
  const setSource = useCallback(
    throttle(
      async (source: Record<string, string>) => {
        // set loading status if still compiling after 499ms
        loadingTimer.current = window.setTimeout(
          () => {
            setLoading(true);
          },
          // make sure timer be fired before next throttle
          THROTTLE_WAIT - 1,
        );

        if (opts?.iframe && opts?.containerRef?.current) {
          const iframeWindow =
            opts.containerRef.current.querySelector('iframe')!.contentWindow!;

          await new Promise<void>((resolve) => {
            const handler = (
              ev: MessageEvent<{
                type: string;
                value: { err: null | Error };
              }>,
            ) => {
              if (ev.data.type.startsWith('dumi.liveDemo.compileDone')) {
                iframeWindow.removeEventListener('message', handler);
                setError(ev.data.value.err);
                resolve();
              }
            };
            iframeWindow.addEventListener('message', handler);
            iframeWindow.postMessage({
              type: 'dumi.liveDemo.setSource',
              value: source,
            });
          });
        } else {
          const entryFileName = Object.keys(asset.dependencies).find(
            (k) => asset.dependencies[k].type === 'FILE',
          )!;
          const require = (v: string) => {
            if (v in context!) return context![v];
            throw new Error(`Cannot find module: ${v}`);
          };

          const token = (taskToken.current = Math.random());
          let entryFileCode = source[entryFileName];

          if (renderOpts?.compile) {
            try {
              entryFileCode = await renderOpts.compile(entryFileCode, {
                filename: entryFileName,
              });
            } catch (error: any) {
              setError(error);
              resetLoadingStatus();
              return;
            }
          }

          if (renderOpts?.renderer && renderOpts?.compile) {
            try {
              const exports: AgnosticComponentType = {};
              const module = { exports };
              evalCommonJS(entryFileCode, {
                exports,
                module,
                require,
              });
              const component = await getAgnosticComponentModule(exports);
              if (renderOpts.preflight) {
                await renderOpts.preflight(component);
              }
              setComponent(component);
              setDemoNode(createElement('div', { ref }));
              setError(null);
            } catch (err: any) {
              setError(err);
              resetLoadingStatus();
            }
            return;
          }

          try {
            // load renderToStaticMarkup in async way
            const renderToStaticMarkupDeferred = import(
              'react-dom/server'
            ).then(({ renderToStaticMarkup }) => renderToStaticMarkup);

            // skip current task if another task is running
            if (token !== taskToken.current) return;

            const exports: { default?: ComponentType } = {};
            const module = { exports };

            // initial component with fake runtime
            evalCommonJS(entryFileCode, {
              exports,
              module,
              require,
            });

            const newDemoNode = createElement(
              DemoErrorBoundary,
              null,
              createElement(exports.default!),
            );
            const oError = console.error;

            // hijack console.error to avoid useLayoutEffect error
            console.error = (...args) =>
              !args[0].includes('useLayoutEffect does nothing on the server') &&
              oError.apply(console, args);

            // check component is able to render, to avoid show react overlay error
            try {
              (await renderToStaticMarkupDeferred)(newDemoNode);
            } catch (err: any) {
              const shouldSkipError =
                err.message.includes(
                  'Unable to find node on an unmounted component',
                ) ||
                err.message.includes(
                  'Portals are not currently supported by the server renderer',
                );
              if (!shouldSkipError) throw err;
            }
            console.error = oError;

            // set new demo node with passing source
            setDemoNode(newDemoNode);
            setError(null);
          } catch (err: any) {
            setError(err);
          }
        }
        resetLoadingStatus();
      },
      THROTTLE_WAIT,
      { leading: true },
    ) as (source: Record<string, string>) => Promise<void>,
    [context, asset, renderOpts],
  );

  return { node: demoNode, loading, error, setSource };
};