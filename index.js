/*global __webpack_require__*/

'use strict';

var isNode = (typeof global!=='undefined') && ({}.toString.call(global)==='[object global]') && (!global.document || ({}.toString.call(global.document)!=='[object HTMLDocument]')),
      NOOP = function() {},
      WINDOW = isNode ? {
           document: {
               addEventListener: NOOP,
               removeEventListener: NOOP,
               location: {}
           }
      } : window,
      DOCUMENT = WINDOW.document,
      documentElement = DOCUMENT.documentElement,
      BODY = DOCUMENT.body,
      objectAssign = require('object-assign'),
      createHistory = require('history').createHistory,
      controller = require('itsa-client-controller'),
      io = require('itsa-io'),
      Event = require('itsa-event'),
      REGEXP_PLACEHOLDER = new RegExp('{((?!}).)+}', 'gi'),
      webpackRequire = __webpack_require__,
      Classes = require('itsa-classes');

var Router = Classes.createClass(function(routes) {
        var instance = this;
        instance.routes = routes || controller.getProps().__routes;
        instance.viewComponents = {};
        instance.clickCb = instance.clickCb.bind(instance);
        instance.destroy = instance.destroy.bind(instance);
        instance.setupHistory();
        instance.setupEvent();
        instance.setupListeners();
        // make sure any instance._viewCompIO gets aborted:
        WINDOW.addEventListener('unload', instance.destroy);
    },
    {

        /*
         *
        **/
        getAnchor: function(node) {
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
            var state = location.state,
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

            var instance = this;
            // the first time will be initiated by the current page.
            // we don't need to load and render this view
            if (!instance.loadViewInitiated) {
                instance.loadViewInitiated = true;
                return;
            }

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
                        eval(data);
                        BodyComponent = webpackRequire(requireId);
                        return BodyComponent;
                    }
                ).catch(function(err) {
                    console.warn(err);
                    delete viewObject.ioComponentPromise;
                });
            }

            if (!viewObject.ioCssPromise) {
                instance._viewCssIO = io.get(origin+pathname, {headers: {'x-css': true}});
                viewObject.ioCssPromise = instance._viewCssIO
                .catch(function(err) {
                    console.warn(err);
                    delete viewObject.ioCssPromise;
                });
            }

            if (controller.getLang()!==lang) {
                // force reload of properties of ALL viewObjects!
                keys = Object.keys(instance.viewComponents);
                keys.forEach(function(key) {delete instance.viewComponents[key].ioPropsPromise;});
            }
            if (!viewObject.ioPropsPromise) {
                instance._viewPropIO = io.read(origin+pathname+search, null, {headers: {'x-props': true, 'x-lang': lang}, preventCache: !staticView});
                viewObject.ioPropsPromise = instance._viewPropIO
                .catch(function(err) {
                    console.warn(err);
                    delete viewObject.ioPropsPromise;
                });
            }

            Promise.all([
                viewObject.ioComponentPromise,
                viewObject.ioCssPromise,
                viewObject.ioPropsPromise
            ])
            .then(
                function(responseArray) {
                    var BodyComponent = responseArray[0],
                        css = responseArray[1],
                        props = responseArray[2],
                        langSwitch = (controller.getLang()!==lang);
                    controller.setPage({
                        view: view,
                        BodyComponent: BodyComponent,
                        title: title,
                        props: props,
                        css: css,
                        staticView: staticView,
                        componentId: componentId,
                        requireId: requireId,
                        lang: lang
                    }).then(function() {instance.emit('pagechanged', {langSwitch: langSwitch});});

                    if (!staticView) {
                        // make sure the props are reloaded again:
                        delete viewObject.ioPropsPromise;
                    }
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
            var view, staticView, title, questionmark, staticURI, requireId, componentId,
            lang, langFromURI, secondSlash, possibleLang;
            questionmark = href.indexOf('\?');
            staticURI = (questionmark===-1);
            staticURI || (href=href.substr(0, questionmark));
            // inspect whether the uri starts with a valid language
            secondSlash = href.indexOf('/', 2);

            if ((secondSlash!==-1) && (href[0]==='/')) {
                // possible language in the uri
                var validLanguages = controller.getProps().__languages; // is an object
                possibleLang = href.substr(1, secondSlash-1);
                if (validLanguages[possibleLang]) {
                    // yes it is a language
                    langFromURI = possibleLang;
                    href = href.substr(secondSlash);
                }
            }
            this.routes.some(function(route) {
                var path = '^'+route.path.replace(REGEXP_PLACEHOLDER, '((?!\/).)+')+'$',
                    reg = new RegExp(path);
                if (reg.test(href)) {
                    view = route.view;
                    staticView = staticURI ? route.staticView : false;
                    title = route.title;
                }
                return view;
            });
            controller.getProps().__routes.some(function(route) {
                if (route.view===view) {
                    requireId = route.requireId;
                    componentId = route.componentId;
                }
                return componentId;
            });
            lang = (switchLang && switchLang.toLowerCase()) || langFromURI || controller.getProps().__lang;
            return {
                view: view,
                staticView: staticView,
                title: (title && title[lang]) || '',
                requireId: requireId,
                componentId: componentId,
                lang: lang
            };
        },

        _defFnNavigate: function(e) {
            var route = e.route;
            e.clickEvent.preventDefault();
            this.history.pushState({ view: route.view, title: route.title, staticView: route.staticView, componentId: route.componentId, requireId: route.requireId, lang: route.lang }, e.href);
        },

        _prevFnNavigate: function(e) {
            // also prevent native clicking
            e.clickEvent.preventDefault();
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
                        // depending of the type, either preventdefault anchor-action
                        // or load the view
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

        registerViewComponent: function(view, viewObject) {
            this.viewComponents[view] = viewObject;
        },

        /*
         *
        **/
        setupHistory: function() {
            var history, search, staticView, componentInfo, cssProps;
            var instance = this;
            if (instance.isBrowserWithHistory()) {
                instance.history = history =createHistory();
                // because the initial state has no `state`-property, we will define it ourselves:
                search = WINDOW.location.search;
                staticView = (search!=='') ? false : controller.isStaticView();
                instance.initialLocation = {
                    pathname: WINDOW.location.pathname,
                    search: search,
                    state: {
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
                    instance.loadView(location.state ? location : instance.initialLocation);
                });
            }
        },

        setupEvent: function() {
            var instance = this;
            var emitter = new Event.Emitter('router');
            objectAssign(instance, emitter);
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