/* global __webpack_require__ */
/* eslint no-empty: 0 */

'use strict';

require('itsa-dom');
require('itsa-jsext/lib/object');

var isNode = require('itsa-utils').isNode,
      NOOP = function() {},
      WINDOW = isNode ? {
           document: {
               addEventListener: NOOP,
               removeEventListener: NOOP,
               location: {}
           },
           pageXOffset: 0,
           pageYOffset: 0,
           innerWidth: 0,
           innerHeight: 0
      } : window,
      DOCUMENT = WINDOW.document,
      documentElement = DOCUMENT.documentElement,
      BODY = DOCUMENT.body,
      objectAssign = require('object-assign'),
      createHistory = require('history').createHistory,
      controller = require('itsa-client-controller'),
      io = require('itsa-fetch').io,
      Event = require('itsa-event'),
      REGEXP_PLACEHOLDER = new RegExp('{((?!}).)+}', 'gi'),
      webpackRequire = __webpack_require__,
      Classes = require('itsa-classes'),
      extractPath, parsePath;

extractPath = function(string) {
    var match = string.match(/^https?:\/\/[^\/]*/);
    if (match === null) {
        return string;
    }
    return string.substring(match[0].length);
};

parsePath = function(path) {
    var pathname = extractPath(path),
        search = '',
        hash = '',
        hashIndex = pathname.indexOf('#'),
        searchIndex;

    if (hashIndex !== -1) {
        hash = pathname.substring(hashIndex);
        pathname = pathname.substring(0, hashIndex);
    }
    searchIndex = pathname.indexOf('?');
    if (searchIndex !== -1) {
        search = pathname.substring(searchIndex);
        pathname = pathname.substring(0, searchIndex);
    }
    (pathname==='') && (pathname = '/');
    return {
        pathname: pathname,
        search: search,
        hash: hash
    };
};

var Router = Classes.createClass(function(routes) {
        var instance = this;
        instance._scrollAnchorTime = 0;
        controller.init();
        instance.routes = routes || controller.getProps().__routes;
        instance.viewComponents = {};
        instance.clickCb = instance.clickCb.bind(instance);
        instance.destroy = instance.destroy.bind(instance);
        instance.setupHistory();
        instance.setupEvent();
        instance.setupListeners();
        // make sure any instance._viewCompIO gets aborted:
        if (WINDOW.addEventListener) {
            WINDOW.addEventListener('unload', instance.destroy);
        }
        else {
            WINDOW.attachEvent('onunload', instance.destroy);
        }
    },
    {

        /*
         *
        **/
        getAnchor: function(node) {
            if (!node) {
                return false;
            }
            if (node===BODY) {
                // also no need to go higher in the domtree
                return false;
            }
            if (node.tagName==='A') {
                return node;
            }
            else {
                node = node.parentNode;
                return this.getAnchor(node);
            }
        },

        /*
         *
        **/
        loadView: function(location) {
            var instance = this,
                state = location.state,
                view = state.view,
                title = state.title,
                staticView = state.staticView,
                componentId = state.componentId,
                requireId = state.requireId,
                lang = state.lang,
                pathname = location.pathname,
                search = location.search,
                origin = WINDOW.location.origin,
                viewObject, keys;

            instance.lastLocation = location.itsa_deepClone(); // for usage when valling `reload`

            // first: currently loading another io-promise: then abort!
            // this way we prevent delay
            if (instance._viewCompIO && instance._viewCompIO.abort) {
                instance._viewCompIO.abort();
            }
            if (instance._viewCssIO && instance._viewCssIO.abort) {
                instance._viewCssIO.abort();
            }
            if (instance._viewPropIO && instance._viewPropIO.abort) {
                instance._viewPropIO.abort();
            }

            viewObject = instance.viewComponents[view];
            if (!viewObject) {
                // create new viewobject and register
                viewObject = {};
                instance.registerViewComponent(view, viewObject);
            }

            if (!viewObject.ioComponentPromise) {
                instance._viewCompIO = io.get(origin+pathname, {headers: {'x-comp': true}});
                viewObject.ioComponentPromise = instance._viewCompIO.then(
                    function(data) {
                        var BodyComponent;
                        // save the requireId that we want to load
                        // only if the server decides to redirect to another view,
                        // then during evaluating `data`, it will be reset to another requireId;
                        WINDOW.itsa_requireId = requireId;
                        eval(data);
                        BodyComponent = webpackRequire(WINDOW.itsa_requireId);
                        return BodyComponent;
                    }
                );
            }

            if (!viewObject.ioCssPromise) {
                instance._viewCssIO = io.get(origin+pathname, {headers: {'x-css': true}});
                viewObject.ioCssPromise = instance._viewCssIO
            }

            if (controller.getLang()!==lang) {
                // force reload of properties of ALL viewObjects!
                keys = Object.keys(instance.viewComponents);
                keys.forEach(function(key) {delete instance.viewComponents[key].ioPropsPromise;});
            }
            if (!viewObject.ioPropsPromise) {
                instance._viewPropIO = io.read(origin+pathname+search, null, {headers: {'x-props': true, 'x-lang': lang}, preventCache: !staticView});
                viewObject.ioPropsPromise = instance._viewPropIO
            }

            return Promise.all([
                viewObject.ioComponentPromise,
                viewObject.ioCssPromise,
                viewObject.ioPropsPromise
            ])
            .then(
                function(responseArray) {
                    var BodyComponent = responseArray[0],
                        css = responseArray[1],
                        props = responseArray[2],
                        langSwitch = (controller.getLang()!==lang),
                        sameView = (view===controller.getView());
                    if (!staticView) {
                        // make sure the props are reloaded again:
                        delete viewObject.ioPropsPromise;
                    }
                    return controller.setPage({
                        view: view,
                        BodyComponent: BodyComponent,
                        title: title,
                        props: props,
                        css: css,
                        staticView: staticView,
                        componentId: componentId,
                        requireId: requireId,
                        lang: lang
                    }).then(function() {
                        sameView || instance.emit('pagechanged', {langSwitch: langSwitch});
                    });
                },
                function() {
                    delete viewObject.ioComponentPromise;
                    delete viewObject.ioCssPromise;
                    delete viewObject.ioPropsPromise;
                }
            );

        },

        /*
         *
        **/
        getRouteFromAnchor: function(href, switchLang) {
            var controllerProps = controller.getProps(),
                view, staticView, title, questionmark, staticURI, requireId, componentId,
            lang, langFromURI, secondSlash, possibleLang, hashPos, hash;
            questionmark = href.indexOf('\?');
            staticURI = (questionmark===-1);
            staticURI || (href=href.substr(0, questionmark));
            // inspect whether the uri starts with a valid language
            secondSlash = href.indexOf('/', 2);

            if ((secondSlash!==-1) && (href[0]==='/')) {
                // possible language in the uri
                var validLanguages = controllerProps.__languages; // is an object
                possibleLang = href.substr(1, secondSlash-1);
                if (validLanguages[possibleLang]) {
                    // yes it is a language
                    langFromURI = possibleLang;
                    href = href.substr(secondSlash);
                }
            }
            // check for hashtags:
            hashPos = href.indexOf('#');
            if (hashPos!==-1) {
                hash = href.substr(hashPos+1);
                href = href.substr(0, hashPos);
            }
            href || (href=WINDOW.location.pathname);
            this.routes.some(function(route) {
                var path = '^'+route.path.replace(REGEXP_PLACEHOLDER, '((?!\/).)+')+'\/?$',
                    reg = new RegExp(path);
                if (reg.test(href)) {
                    view = route.view;
                    staticView = staticURI ? route.staticView : false;
                    title = route.title;
                }
                return view;
            });
            controllerProps.__routes.some(function(route) {
                if (route.view===view) {
                    requireId = route.requireId;
                    componentId = route.componentId;
                }
                return componentId;
            });
            lang = (switchLang && switchLang.toLowerCase()) || langFromURI || controllerProps.__lang;
            return {
                view: view,
                staticView: staticView,
                title: (title && title[lang]) || '',
                requireId: requireId,
                componentId: componentId,
                lang: lang,
                langPrefix: !langFromURI && controllerProps.__langprefix,
                hash: hash
            };
        },

        _defFnNavigate: function(e) {
            var route = e.route,
                href = e.href,
                hash = (route.hash ? '#'+route.hash : ''),
                hashPos, pathSplit;
            e.clickEvent && e.clickEvent.preventDefault();
            // Set langprefix:
            if (href.itsa_startsWith('/') && route.langPrefix) {
                href = route.langPrefix + href;
            }
            // check for hashtags:
            hashPos = href.indexOf('#');
            if (hashPos!==-1) {
                href = href.substr(0, hashPos);
            }
            href || (href=WINDOW.location.pathname);
            e.prevView = controller.getView();
            e.pageChanged = (e.prevView!==route.view);

            pathSplit = parsePath(href+hash);

            this.history.push({
                pathname: pathSplit.pathname,
                search: pathSplit.search,
                hash: pathSplit.hash,
                state: {
                    path: e.href, // need to be set: to check for changes when using the same view
                    view: route.view,
                    title: route.title,
                    staticView: route.staticView,
                    componentId: route.componentId,
                    requireId: route.requireId,
                    lang: route.lang,
                    hash: route.hash
                }
            });
        },

        _prevFnNavigate: function(e) {
            // also prevent native clicking
            e.clickEvent && e.clickEvent.preventDefault();
        },

        _defFnPageChanged: function(e) {
            e.langSwitch || WINDOW.scrollTo(0, 0);
            if (WINDOW.ga) {
                WINDOW.ga('set', 'page', WINDOW.location.href);
                WINDOW.ga('send', 'pageview');
            }
        },

        /*
         *
        **/
        clickCb: function(e) {
            var route, href, switchLang;
            var instance = this;
            var anchorNode = instance.getAnchor(e.target);
            if (anchorNode) {
                // node is a anchor-node here.
                // now we need to check if there is a match with routes
                href = anchorNode.getAttribute('href');
                if (href) {
                    switchLang = anchorNode.getAttribute('data-setlang');
                    route = instance.getRouteFromAnchor(href, switchLang);
                    if (route.view) {
                        instance.emit('navigate', {
                            clickEvent: e,
                            route: route,
                            href: href
                        });
                    }
                }
            }
        },

        /*
         *
        **/
        isBrowserWithHistory: function() {
            // only activated to browsers with history-support
            return (WINDOW.history && WINDOW.history.pushState);
        },

        gotoUrl: function(url, clearCache) {
            var instance = this,
                route;
            if (!instance.isBrowserWithHistory()) {
                WINDOW.location = url;
            }
            else {
                clearCache && instance.clearViewCache();
                route = instance.getRouteFromAnchor(url);
                if (route.view) {
                    instance.emit('navigate', {
                        route: route,
                        href: url,
                        manual: true
                    });
                }
            }
        },

        reloadView: function(clearCache) {
            var instance = this,
                location;
            clearCache && instance.clearViewCache();
            location = (instance.lastLocation || instance.initialLocation).itsa_deepClone();
            location.state = instance.getRouteFromAnchor(location.pathname);
            instance.loadView(location);
        },

        reloadInitialView: function(clearCache) {
            var instance = this;
            clearCache && instance.clearViewCache();
            instance.loadView(instance.initialLocation);
        },

        clearViewCache: function() {
            this.viewComponents = {};
        },

        registerViewComponent: function(view, viewObject) {
            this.viewComponents[view] = viewObject;
        },

        saveHistoryHash: function(hash) {
            this._saveHistoryHash(hash, true);
        },

        _saveHistoryHash: function(hash, historyPush) {
            var instance = this,
                href = href=WINDOW.location.pathname,
                route;
            if (hash) {
                (hash[0]==='#') || (hash='#'+hash);
                href += hash;
            }
            route = instance.getRouteFromAnchor(href);
            if (route.view) {
                instance.emit && instance.emit('navigate', {
                    route: route,
                    href: href,
                    historyPush: historyPush
                });
            }
        },

        scrollToNode: function(node) {
            node.itsa_scrollIntoView(true, true, this._scrollAnchorTime);
        },

        setScrollAnchorTime: function(value) {
            this._scrollAnchorTime = value || 0;
        },

        /*
         *
        **/
        setupHistory: function() {
            var history, search, staticView, componentInfo, cssProps;
            var instance = this;
            if (instance.isBrowserWithHistory()) {
                instance.history = history = createHistory();
                // because the initial state has no `state`-property, we will define it ourselves:
                search = WINDOW.location.search;
                staticView = (search!=='') ? false : controller.isStaticView();
                instance.initialLocation = {
                    pathname: WINDOW.location.pathname,
                    search: search,
                    state: {
                        path: WINDOW.location, // need to be set: to check for changes when using the same view
                        title: controller.getTitle(),
                        view: controller.getView(),
                        componentId: controller.getComponentId(),
                        requireId: controller.getRequireId(),
                        staticView: staticView,
                        lang: controller.getProps().__lang
                    }
                };

                // specify that this view is already in use:
                componentInfo = {
                    ioComponentPromise: controller.getBodyComponent(),
                    ioPropsPromise: staticView && Promise.resolve(controller.getProps())
                };
                cssProps = controller.getCss();
                if (cssProps) {
                    componentInfo.ioCssPromise = Promise.resolve(cssProps);
                }
                instance.registerViewComponent(controller.getView(), componentInfo);

                instance.unlistenHistory = history.listen(function(location) {
                    var hashNode;
                    location.state || (location = instance.initialLocation);
                    if (location.state && (location.state.view===controller.getView()) && (location.state.path===WINDOW.location) && (location.state.lang==controller.getLang())) {
                        hashNode = location.hash && DOCUMENT.getElementById(location.hash.substr(1));
                        hashNode && instance.scrollToNode(hashNode);
                        instance._saveHistoryHash(location.hash); // fire event without save history
                    }
                    else {
                        instance.loadView(location);
                    }
                });
            }
        },

        setupEvent: function() {
            var instance = this;
            var emitter = new Event.Emitter('router');
            instance.itsa_merge(emitter, {force: 'deep'});
            instance.defineEvent('navigate')
                     .defaultFn(instance._defFnNavigate)
                     .preventedFn(instance._prevFnNavigate);
            instance.defineEvent('pagechanged')
                    .defaultFn(instance._defFnPageChanged)
                    .unPreventable();
        },

        /*
         *
        **/
        setupListeners: function() {
            var instance = this;
            if (instance.isBrowserWithHistory()) {
                documentElement.addEventListener('click', instance.clickCb, true);
                instance.hasListeners = true;
            }
        },

        /*
         *
        **/
        removeListeners: function() {
            if (this.hasListeners) {
                documentElement.removeEventListener('click', this.clickCb, true);
            }
        },

        /*
         *
        **/
        destroy: function() {
            var instance = this;
            instance.undefAllEvents();
            if (instance.isBrowserWithHistory()) {
                instance.removeListeners();
                instance.unlistenHistory();
                if (instance._viewCompIO && instance._viewCompIO.abort) {
                    instance._viewCompIO.abort();
                }
                if (instance._viewPropIO && instance._viewPropIO.abort) {
                    instance._viewPropIO.abort();
                }
                if (instance._viewCssIO && instance._viewCssIO.abort) {
                    instance._viewCssIO.abort();
                }
            }
        }
    });

module.exports = Router;