// @ts-check
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Graphene from 'gi://Graphene';
import IBus from 'gi://IBus';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Signals from '../misc/signals.js';
import * as BoxPointer from './boxpointer.js';
import * as InputSourceManager from './status/keyboard.js';
import * as IBusManager from '../misc/ibusManager.js';
import * as Main from './main.js';
import * as PageIndicators from './pageIndicators.js';
import * as PopupMenu from './popupMenu.js';
import * as SwipeTracker from './swipeTracker.js';

/** @import {EmojiKey, EmojiSection, EmojiPage, KeyParams} from './keyboard' */
/** @import {LayoutKey, KeyboardLayout, SwipeTrackerInstance} from './keyboard' */

export const KEYBOARD_ANIMATION_TIME = 150;
const KEYBOARD_REST_TIME = KEYBOARD_ANIMATION_TIME * 2;

const A11Y_APPLICATIONS_SCHEMA = 'org.gnome.desktop.a11y.applications';
const SHOW_KEYBOARD = 'screen-keyboard-enabled';
const SHELL_SCHEMA = 'org.gnome.shell';
const SPLIT_KEYBOARD_ENABLED = 'screen-keyboard-split-enabled';
const SPLIT_KEYBOARD_SIDE_SIZE = 'screen-keyboard-split-side-size';
const EMOJI_PAGE_SEPARATION = 32;
const SPLIT_KEYBOARD_MIN_SIDE_SIZE = 250;
const SPLIT_KEYBOARD_MIN_GAP = 64;
const SPLIT_KEYBOARD_HANDLE_WIDTH = 48;
const CM = 10;
const SIZE_OF_THUMBS_CM = 3;
const SPLIT_KEYBOARD_MAX_REACH_MM = SIZE_OF_THUMBS_CM * 2 * CM;

/* KeyContainer puts keys in a grid where a 1:1 key takes this size */
const KEY_SIZE = 2;

const KEY_RELEASE_TIMEOUT = 50;
const BACKSPACE_WORD_DELETE_THRESHOLD = 50;

const AspectContainer = GObject.registerClass(
class AspectContainer extends St.Widget {
    /**
     * @param {Partial<St.Widget.ConstructorProps>} params
     */
    constructor(params) {
        super(params);
        this._ratio = 1;
        this._radioOrig = [1, 1];
    }

    /**
     * @param {[number, number]} ratio
     */
    set ratio(ratio) {
        const [relWidth, relHeight] = ratio;
        this._ratio = relWidth / relHeight;
        this._ratioOrig = ratio;
        this.queue_relayout();
    }

    get ratio() {
        return this._ratioOrig;
    }

    /**
     * @override
     * @param {number} forHeight
     * @returns {[number, number]}
     */
    vfunc_get_preferred_width(forHeight) {
        let [min, nat] = super.vfunc_get_preferred_width(forHeight);

        if (forHeight > 0)
            nat = forHeight * this._ratio;

        return [min, nat];
    }

    /**
     * @override
     * @param {number} forWidth
     * @returns {[number, number]}
     */
    vfunc_get_preferred_height(forWidth) {
        let [min, nat] = super.vfunc_get_preferred_height(forWidth);

        if (forWidth > 0)
            nat = forWidth / this._ratio;

        return [min, nat];
    }

    /**
     * @param {Clutter.ActorBox} box
     * @override
     */
    vfunc_allocate(box) {
        if (box.get_width() > 0 && box.get_height() > 0) {
            const sizeRatio = box.get_width() / box.get_height();
            if (sizeRatio >= this._ratio) {
                /* Restrict horizontally */
                const width = box.get_height() * this._ratio;
                const diff = box.get_width() - width;

                box.x1 += Math.floor(diff / 2);
                box.x2 -= Math.ceil(diff / 2);
            }
        }

        super.vfunc_allocate(box);
    }
});

class NoGrabPopup extends PopupMenu.PopupMenu {
    /**
     * @param {Clutter.Actor} actor
     * @param {St.Side} arrowSide
     */
    constructor(actor, arrowSide) {
        super(actor, 0.5, arrowSide);

        actor.connectObject(
            'destroy', () => this.close(BoxPointer.PopupAnimation.FULL),
            'notify::mapped', () => {
                if (!actor.is_mapped())
                    this.close(BoxPointer.PopupAnimation.FULL);
            },
            this);

        this._clickGesture = new Clutter.ClickGesture();
        this._clickGesture.connect(
            'may-recognize', this._onMayRecognize.bind(this));
        this._clickGesture.connect(
            'recognize', () => this.close(BoxPointer.PopupAnimation.FULL));
    }

    /** @param {Clutter.ClickGesture} gesture */
    _onMayRecognize(gesture) {
        const {x, y} = gesture.get_coords_abs();
        const targetActor = global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y);

        return targetActor !== this.actor && !this.actor.contains(targetActor);
    }

    open(params = {}) {
        if (!super.open(params))
            return false;

        global.stage.add_action_full(
            'close-popup-gesture',
            Clutter.EventPhase.CAPTURE,
            this._clickGesture);
        return true;
    }

    close(params = {}) {
        if (!super.close(params))
            return false;
        global.stage.remove_action(this._clickGesture);
        return true;
    }

    destroy() {
        global.stage.remove_action(this._clickGesture);
        this.sourceActor.disconnectObject(this);
        super.destroy();
    }
};

const KeyContainer = GObject.registerClass(
class KeyContainer extends St.Widget {
    _nRows = 0;
    _currentCol = 0;
    _maxCols = 0;
    _destroyID = 0;

    /** @type {InstanceType<typeof Key>[]} */
    shiftKeys = [];

    mode = '';

    constructor() {
        const gridLayout = new Clutter.GridLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            column_homogeneous: true,
            row_homogeneous: true,
        });
        super({
            layout_manager: gridLayout,
            x_expand: true,
            y_expand: true,
        });
        this._gridLayout = gridLayout;
    }

    appendRow() {
        this._nRows++;
        this._currentCol = 0;
    }

    /**
     * Adds a new key to this key container, adding to the inner grid layout.
     *
     * @param {Clutter.Actor} key
     * @param {number} width
     * @param {number} height
     * @param {number} leftOffset
     */
    appendKey(key, width = 1, height = 1, leftOffset = 0) {
        const left = this._currentCol + leftOffset;
        const top = this._nRows;
        this._gridLayout.attach(key,
            left * KEY_SIZE, top * KEY_SIZE,
            width * KEY_SIZE, height * KEY_SIZE);

        this._currentCol += leftOffset + width;
        this._maxCols = Math.max(this._currentCol, this._maxCols);
    }

    /** @param {number} width */
    ensureGridWidth(width) {
        if (width <= this._maxCols)
            return;

        // GridLayout only creates columns occupied by an actor. This
        // transparent actor makes paired split layouts use the same logical
        // column width without adding another visible row.
        const expander = new Clutter.Actor({opacity: 0});
        this._gridLayout.attach(expander,
            0, KEY_SIZE,
            width * KEY_SIZE, KEY_SIZE);
        this._maxCols = width;
    }

    /** @returns {[number, number]} */
    get ratio() {
        return [this._maxCols, this._nRows];
    }
});

const Suggestions = GObject.registerClass({
    Signals: {'settings-requested': {}},
},
class Suggestions extends St.BoxLayout {
    constructor() {
        super({
            style_class: 'word-suggestions',
            orientation: Clutter.Orientation.HORIZONTAL,
            x_align: Clutter.ActorAlign.START
        });
        this._suggestionButtons = new Set();
        this._suggestionsVisible = true;

        this.settingsButton = new St.Button({
            accessible_name: _('Keyboard Settings'),
            can_focus: false,
            icon_name: 'emblem-system-symbolic',
            style_class: 'icon-button flat keyboard-settings',

        });
        this.settingsButton.connect('clicked', () => {
            this.emit('settings-requested');
        });
        this.add_child(this.settingsButton);
        this.show();
    }

    _syncSettingsButton() {
        this.settingsButton.visible =
        !this._suggestionsVisible || this._suggestionButtons.size === 0;
        super.xAlign = this.settingsButton.visible ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER;
    }

    /**
     * @param {string} word
     * @param {() => void} callback
     */
    add(word, callback) {
        const button = new St.Button({
            label: word,
            style_class: 'word-suggestion',
        });
        button.connect('clicked', () => callback());
        button.visible = this._suggestionsVisible;
        this._suggestionButtons.add(button);
        this.add_child(button);
        this._syncSettingsButton();
    }

    clear() {
        for (const button of this._suggestionButtons)
            button.destroy();
        this._suggestionButtons.clear();
        this._syncSettingsButton();
    }

    /** @param {boolean} visible */
    setVisible(visible) {
        this._suggestionsVisible = visible;
        for (const button of this._suggestionButtons)
            button.visible = visible;
        this._syncSettingsButton();
    }
});

class KeyboardSettingsPopup extends NoGrabPopup {
    /**
     * @param {Clutter.Actor} actor
     * @param {Gio.Settings} settings
     * @param {boolean} touchscreenAvailable
     */
    constructor(actor, settings, touchscreenAvailable) {
        super(actor, St.Side.BOTTOM);

        const splitItem = new PopupMenu.PopupSwitchMenuItem(
            _('Use Split Keyboard'), false, {can_focus: false});
        settings.bind(SPLIT_KEYBOARD_ENABLED,
            splitItem, 'state', Gio.SettingsBindFlags.DEFAULT);
        if (!touchscreenAvailable)
            splitItem.setStatus(_('Unavailable'));
        this.addMenuItem(splitItem);

        this.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settingsItem = this.addSettingsAction(
            _('More settings...'), 'gnome-keyboard-panel.desktop');
        settingsItem.can_focus = false;
    }
}

class LanguageSelectionPopup extends NoGrabPopup {
    /** @param {Clutter.Actor} actor */
    constructor(actor) {
        super(actor, St.Side.BOTTOM);

        const inputSourceManager = InputSourceManager.getInputSourceManager();
        /** @type {Record<string, typeof inputSourceManager.currentSource>} */
        const inputSources = inputSourceManager.inputSources;

        let item;
        for (const i in inputSources) {
            const is = inputSources[i];

            item = this.addAction(is.displayName, () => {
                inputSourceManager.activateInputSource(is, true);
            });
            item.can_focus = false;
            item.setOrnament(is === inputSourceManager.currentSource
                ? PopupMenu.Ornament.DOT
                : PopupMenu.Ornament.NO_DOT);
        }
    }
}

const Key = GObject.registerClass({
    Signals: {
        'long-press': {},
        'released': {},
        'keyval': {param_types: [GObject.TYPE_UINT]},
        'commit': {param_types: [GObject.TYPE_STRING]},
    },
}, class Key extends St.BoxLayout {
    /**
     * @param {KeyParams} params
     * @param {string[]} extendedKeys
     */
    constructor(params, extendedKeys = []) {
        const {label, iconName, commitString, keyval, hasAction} = {keyval: '0', ...params};
        super({style_class: 'key-container'});

        this._keyval = parseInt(keyval, 16);
        this.keyButton = this._makeKey(commitString, label, iconName);

        /* Add the key in a container, so keys can be padded without losing
         * logical proportions between those.
         */
        this.add_child(this.keyButton);
        this.connect('destroy', this._onDestroy.bind(this));

        this._extendedKeys = extendedKeys;
        this._extendedKeyboard = null;
        this._hasAction = hasAction;
    }

    get iconName() {
        return this._icon.icon_name;
    }

    set iconName(value) {
        this._icon.icon_name = value;
    }

    _onDestroy() {
        if (this._menu) {
            this._menu.destroy();
            this._menu = null;
        }
    }

    _ensureExtendedKeysPopup() {
        if (this._extendedKeys.length === 0)
            return;

        if (this._menu)
            return;

        this._menu = new NoGrabPopup(this.keyButton, St.Side.BOTTOM);
        this._menu.actor.add_style_class_name('keyboard-subkeys-boxpointer');
        this._menu.box.orientation = Clutter.Orientation.HORIZONTAL;
        this._menu.box.style_class = 'key-container';

        for (const extendedKey of this._extendedKeys) {
            const key = this._makeKey(extendedKey);
            key.extendedKey = extendedKey;
            this._menu.box.add_child(key);
            key.set_size(...this.keyButton.allocation.get_size());
        }

        this.keyButton._extendedKeys = this._extendedKeyboard;
        Main.layoutManager.addTopChrome(this._menu.actor);
    }

    _showSubkeys() {
        this._menu.open(BoxPointer.PopupAnimation.FULL);
    }

    _hideSubkeys() {
        this._menu?.close(BoxPointer.PopupAnimation.FULL);
    }

    /**
     * @param {string} [commitString]
     * @param {string} [label]
     * @param {string} [icon]
     */
    _makeKey(commitString, label, icon) {
        /** @type {St.Button & { _extendedKeys?: Clutter.Actor | null, extendedKey?: string }} */
        const button = new St.Button({
            style_class: 'keyboard-key',
            x_expand: true,
        });

        if (icon) {
            const child = new St.Icon({icon_name: icon});
            button.set_child(child);
            this._icon = child;
        } else if (label) {
            button.set_label(label);
        } else if (commitString) {
            button.set_label(commitString);
        }

        const longPressGesture = new Clutter.LongPressGesture();
        longPressGesture.connect('recognize', () => {
            this.emit('long-press');
            if (this._extendedKeys.length > 0) {
                this._ensureExtendedKeysPopup();
                this._showSubkeys();
            }
        });
        button.add_action(longPressGesture);

        button.connect('clicked', () => {
            if (this._keyval && button === this.keyButton)
                this.emit('keyval', this._keyval);
            else if (commitString)
                this.emit('commit', commitString);
            else if (!this._hasAction)
                console.error('Need keyval, commitString or an action');

            this.emit('released');
            this._hideSubkeys();
        });

        return button;
    }

    /** @param {boolean} latched */
    setLatched(latched) {
        if (latched)
            this.keyButton.add_style_pseudo_class('latched');
        else
            this.keyButton.remove_style_pseudo_class('latched');
    }
});

class KeyboardModel {
    /** @param {string} groupName */
    constructor(groupName) {
        this._model = this._loadModel(groupName);
    }

    /**
     * @param {string} groupName
     * @returns {KeyboardLayout}
     */
    _loadModel(groupName) {
        const file = Gio.File.new_for_uri(
            `resource:///org/gnome/shell/osk-layouts/${groupName}.json`);
        const [success_, contents] = file.load_contents(null);

        const decoder = new TextDecoder();
        return JSON.parse(decoder.decode(contents));
    }

    get levels() {
        return this._model.levels;
    }

    /** @param {string} levelName */
    getKeysForLevel(levelName) {
        return this._model.levels.find(level => level.level === levelName);
    }
}

class FocusTracker extends Signals.EventEmitter {
    constructor() {
        super();

        this._rect = null;

        global.display.connectObject(
            'notify::focus-window', () => {
                this.currentWindow = global.display.focus_window;
                this.emit('window-changed', this._currentWindow);
            },
            'grab-op-begin',
            /**
             * @param {Meta.Display} display
             * @param {Meta.Window} window
             * @param {Meta.GrabOp} op
             * @param {Clutter.Actor} _sprite
             */
            (display, window, op, _sprite) => {
                if (window === this._currentWindow &&
                    (op === Meta.GrabOp.MOVING || op === Meta.GrabOp.KEYBOARD_MOVING))
                    this.emit('window-grabbed');
            }, this);

        this.currentWindow = global.display.focus_window;

        /* Valid for wayland clients */
        Main.inputMethod.connectObject('cursor-location-changed',
            /**
             * @param {Clutter.InputMethod} o
             * @param {Graphene.Rect} rect
             */
            (o, rect) => this._setCurrentRect(rect), this);

        this._ibusManager = IBusManager.getIBusManager();
        this._ibusManager.connectObject(
            'set-cursor-location',
            /**
             * @param {object} manager
             * @param {{x: number, y: number, width: number, height: number}} rect
             */
            (manager, rect) => {
                /* Valid for X11 clients only */
                if (Main.inputMethod.currentFocus)
                    return;

                const grapheneRect = new Graphene.Rect();
                grapheneRect.init(rect.x, rect.y, rect.width, rect.height);

                this._setCurrentRect(grapheneRect);
            },
            'focus-in', () => this.emit('focus-changed', true),
            'focus-out', () => this.emit('focus-changed', false),
            this);
    }

    destroy() {
        this._currentWindow?.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.inputMethod.disconnectObject(this);
        this._ibusManager.disconnectObject(this);
    }

    get currentWindow() {
        return this._currentWindow;
    }

    /** @param {Meta.Window | null} window */
    set currentWindow(window) {
        this._currentWindow?.disconnectObject(this);

        this._currentWindow = window;

        if (this._currentWindow) {
            this._currentWindow.connectObject(
                'position-changed', () => this.emit('window-moved'), this);
        }
    }

    /** @param {Graphene.Rect} rect */
    _setCurrentRect(rect) {
        // Some clients give us 0-sized rects, in that case set size to 1
        if (rect.size.width <= 0)
            rect.size.width = 1;
        if (rect.size.height <= 0)
            rect.size.height = 1;

        if (this._currentWindow) {
            const frameRect = this._currentWindow.get_frame_rect();
            const grapheneFrameRect = new Graphene.Rect();
            grapheneFrameRect.init(frameRect.x, frameRect.y,
                frameRect.width, frameRect.height);

            const rectInsideFrameRect = grapheneFrameRect.intersection(rect)[0];
            if (!rectInsideFrameRect)
                return;
        }

        if (this._rect && this._rect.equal(rect))
            return;

        this._rect = rect;
        this.emit('position-changed');
    }

    get currentRect() {
        const rect = {
            x: this._rect.origin.x,
            y: this._rect.origin.y,
            width: this._rect.size.width,
            height: this._rect.size.height,
        };

        return rect;
    }
}

const EmojiPager = GObject.registerClass({
    Properties: {
        'delta': GObject.ParamSpec.int(
            'delta', null, null,
            GObject.ParamFlags.READWRITE,
            GLib.MININT32, GLib.MAXINT32, 0),
    },
    Signals: {
        'emoji': {param_types: [GObject.TYPE_STRING]},
        'page-changed': {
            param_types: [GObject.TYPE_INT, GObject.TYPE_INT, GObject.TYPE_INT],
        },
    },
}, class EmojiPager extends St.Widget {
    /** @param {EmojiSection[]} sections */
    constructor(sections) {
        super({
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            clip_to_allocation: true,
            y_expand: true,
        });
        this._sections = sections;

        /** @type {EmojiPage[]} */
        this._pages = [];
        /** @type {St.Widget | null} */
        this._panel = null;
        /** @type {number | null} */
        this._curPage = null;
        /** @type {number | null} */
        this._followingPage = null;
        /** @type {St.Widget | null} */
        this._followingPanel = null;
        /** @type {number} */
        this._delta = 0;
        /** @type {number | null} */
        this._width = null;
        this._nRows = 0;
        this._nCols = 0;

        const swipeTracker = new SwipeTracker.SwipeTracker(this,
            Clutter.Orientation.HORIZONTAL,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
            {
                allowDrag: true,
                allowScroll: true,
                name: 'EmojiPager swipe tracker',
            });
        swipeTracker.connect('begin', this._onSwipeBegin.bind(this));
        swipeTracker.connect('update', this._onSwipeUpdate.bind(this));
        swipeTracker.connect('end', this._onSwipeEnd.bind(this));
        this._swipeTracker = swipeTracker;

        this.connect('destroy', () => this._onDestroy());

        this.bind_property(
            'visible', this._swipeTracker, 'enabled',
            GObject.BindingFlags.DEFAULT);
    }

    _onDestroy() {
        if (this._swipeTracker) {
            this._swipeTracker.destroy();
            delete this._swipeTracker;
        }
    }

    /** @returns {number} */
    get delta() {
        return this._delta;
    }

    set delta(value) {
        if (this._delta === value)
            return;

        this._delta = value;
        this.notify('delta');

        const followingPage = this.getFollowingPage();

        if (this._followingPage !== followingPage) {
            if (this._followingPanel) {
                this._followingPanel.destroy();
                this._followingPanel = null;
            }

            if (followingPage != null) {
                this._followingPanel = this._generatePanel(followingPage);
                this.add_child(this._followingPanel);
            }

            this._followingPage = followingPage;
        }

        const multiplier = this.text_direction === Clutter.TextDirection.RTL
            ? -1 : 1;

        this._panel.translation_x = value * multiplier;
        if (this._followingPanel) {
            const translation = value < 0
                ? this._width + EMOJI_PAGE_SEPARATION
                : -this._width - EMOJI_PAGE_SEPARATION;

            this._followingPanel.translation_x =
                (value * multiplier) + (translation * multiplier);
        }
    }

    /** @param {number} nPage */
    _prevPage(nPage) {
        return (nPage + this._pages.length - 1) % this._pages.length;
    }

    /** @param {number} nPage */
    _nextPage(nPage) {
        return (nPage + 1) % this._pages.length;
    }

    getFollowingPage() {
        if (this.delta === 0)
            return null;

        if (this.delta < 0)
            return this._nextPage(this._curPage);
        else
            return this._prevPage(this._curPage);
    }

    /**
     * @param {SwipeTrackerInstance} tracker
     * @param {number} progress
     */
    _onSwipeUpdate(tracker, progress) {
        this.delta = -progress * this._width;
        return false;
    }

    /** @param {SwipeTrackerInstance} tracker */
    _onSwipeBegin(tracker) {
        this._width = this.width;
        const points = [-1, 0, 1];
        tracker.confirmSwipe(this._width, points, 0, 0);
    }

    /**
     * @param {SwipeTrackerInstance} tracker
     * @param {number} duration
     * @param {number} endProgress
     */
    _onSwipeEnd(tracker, duration, endProgress) {
        this.remove_all_transitions();
        if (endProgress === 0) {
            this.ease_property('delta', 0, {duration});
        } else {
            const value = endProgress < 0
                ? this._width + EMOJI_PAGE_SEPARATION
                : -this._width - EMOJI_PAGE_SEPARATION;
            this.ease_property('delta', value, {
                duration,
                onComplete: () => {
                    this.setCurrentPage(this.getFollowingPage());
                },
            });
        }
    }

    _initPagingInfo() {
        /** @type {EmojiPage[]} */
        this._pages = [];

        for (let i = 0; i < this._sections.length; i++) {
            const section = this._sections[i];
            const itemsPerPage = this._nCols * this._nRows;
            const nPages = Math.ceil(section.keys.length / itemsPerPage);
            let page = -1;
            /** @type {EmojiKey[]} */
            let pageKeys = [];

            for (let j = 0; j < section.keys.length; j++) {
                if (j % itemsPerPage === 0) {
                    page++;
                    pageKeys = [];
                    this._pages.push({pageKeys, nPages, page, section: this._sections[i]});
                }

                pageKeys.push(section.keys[j]);
            }
        }
    }

    /**
     * @param {EmojiSection} section
     * @param {number} nPage
     */
    _lookupSection(section, nPage) {
        for (let i = 0; i < this._pages.length; i++) {
            const page = this._pages[i];

            if (page.section === section && page.page === nPage)
                return i;
        }

        return -1;
    }

    /** @param {number} nPage */
    _generatePanel(nPage) {
        const gridLayout = new Clutter.GridLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            column_homogeneous: true,
            row_homogeneous: true,
        });
        const panel = new St.Widget({
            layout_manager: gridLayout,
            style_class: 'emoji-page',
            x_expand: true,
            y_expand: true,
        });

        /* Set an expander actor so all proportions are right despite the panel
         * not having all rows/cols filled in.
         */
        const expander = new Clutter.Actor();
        gridLayout.attach(expander, 0, 0, this._nCols, this._nRows);

        const page = this._pages[nPage];
        let col = 0;
        let row = 0;

        for (let i = 0; i < page.pageKeys.length; i++) {
            const modelKey = page.pageKeys[i];
            const key = new Key({commitString: modelKey.label}, modelKey.variants);

            key.connect('commit', (actor, str) => {
                this.emit('emoji', str);
            });

            gridLayout.attach(key, col, row, 1, 1);

            col++;
            if (col >= this._nCols) {
                col = 0;
                row++;
            }
        }

        return panel;
    }

    /** @param {number} nPage */
    setCurrentPage(nPage) {
        if (this._curPage === nPage)
            return;

        this._curPage = nPage;

        if (this._panel) {
            this._panel.destroy();
            this._panel = null;
        }

        /* Reuse followingPage if possible */
        if (nPage === this._followingPage) {
            this._panel = this._followingPanel;
            this._followingPanel = null;
        }

        if (this._followingPanel)
            this._followingPanel.destroy();

        this._followingPanel = null;
        this._followingPage = null;
        this._delta = 0;

        if (!this._panel) {
            this._panel = this._generatePanel(nPage);
            this.add_child(this._panel);
        }

        const page = this._pages[nPage];
        this.emit('page-changed', page.section.label, page.page, page.nPages);
    }

    /**
     * @param {EmojiSection} section
     * @param {number} nPage
     */
    setCurrentSection(section, nPage) {
        for (let i = 0; i < this._pages.length; i++) {
            const page = this._pages[i];

            if (page.section === section && page.page === nPage) {
                this.setCurrentPage(i);
                break;
            }
        }
    }

    /**
     * @param {[number, number]} ratio
     */
    set ratio(ratio) {
        [this._nCols, this._nRows] = ratio;
        this._initPagingInfo();
    }
});

const EmojiSelection = GObject.registerClass({
    Signals: {
        'emoji-selected': {param_types: [GObject.TYPE_STRING]},
        'close-request': {},
        'toggle': {},
    },
}, class EmojiSelection extends St.Widget {
    constructor() {
        const gridLayout = new Clutter.GridLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            column_homogeneous: true,
            row_homogeneous: true,
        });
        super({
            layout_manager: gridLayout,
            style_class: 'emoji-panel',
            x_expand: true,
            y_expand: true,
            text_direction: global.stage.text_direction,
        });

        /** @type {EmojiSection[]} */
        this._sections = [
            {first: 'grinning face', label: '🙂️'},
            {first: 'selfie', label: '👍️'},
            {first: 'monkey face', label: '🌷️'},
            {first: 'grapes', label: '🍴️'},
            {first: 'globe showing Europe-Africa', label: '✈️'},
            {first: 'jack-o-lantern', label: '🏃️'},
            {first: 'muted speaker', label: '🔔️'},
            {first: 'ATM sign', label: '❤️'},
            {first: 'chequered flag', label: '🚩️'},
        ];

        this._gridLayout = gridLayout;
        this._populateSections();

        this._pagerBox = new Clutter.Actor({
            layout_manager: new Clutter.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
            }),
        });

        this._emojiPager = new EmojiPager(this._sections);
        this._emojiPager.connect('page-changed', (pager, sectionLabel, page, nPages) => {
            this._onPageChanged(sectionLabel, page, nPages);
        });
        this._emojiPager.connect('emoji', (pager, str) => {
            this.emit('emoji-selected', str);
        });
        this._pagerBox.add_child(this._emojiPager);

        this._pageIndicator = new PageIndicators.PageIndicators(
            Clutter.Orientation.HORIZONTAL);
        this._pageIndicator.y_expand = false;
        this._pageIndicator.y_align = Clutter.ActorAlign.START;
        // The PageIndicators override returns a tuple, but that annotation is
        // outside this file's incremental type-checking scope.
        // @ts-expect-error PageIndicators is a Clutter.Actor at runtime
        this._pagerBox.add_child(this._pageIndicator);
        this._pageIndicator.setReactive(false);

        this._emojiPager.connect('notify::delta', () => {
            this._updateIndicatorPosition();
        });

        this._bottomRow = this._createBottomRow();

        this._curPage = 0;
    }

    vfunc_map() {
        this._emojiPager.setCurrentPage(0);
        super.vfunc_map();
    }

    /**
     * @param {string} sectionLabel
     * @param {number} page
     * @param {number} nPages
     */
    _onPageChanged(sectionLabel, page, nPages) {
        this._curPage = page;
        this._pageIndicator.setNPages(nPages);
        this._updateIndicatorPosition();

        for (let i = 0; i < this._sections.length; i++) {
            const sect = this._sections[i];
            sect.button.setLatched(sectionLabel === sect.label);
        }
    }

    _updateIndicatorPosition() {
        this._pageIndicator.setCurrentPosition(this._curPage -
            this._emojiPager.delta / this._emojiPager.width);
    }

    /** @param {string} emoji */
    _findSection(emoji) {
        for (let i = 0; i < this._sections.length; i++) {
            if (this._sections[i].first === emoji)
                return this._sections[i];
        }

        return null;
    }

    _populateSections() {
        const file = Gio.File.new_for_uri('resource:///org/gnome/shell/osk-layouts/emoji.json');
        const [success_, contents] = file.load_contents(null);

        const emoji = JSON.parse(new TextDecoder().decode(contents));

        let variants = [];
        let currentKey = 0;
        let currentSection = null;

        for (let i = 0; i < emoji.length; i++) {
            /* Group variants of a same emoji so they appear on the key popover */
            if (emoji[i].name.startsWith(emoji[currentKey].name)) {
                variants.push(emoji[i].char);
                if (i < emoji.length - 1)
                    continue;
            }

            const newSection = this._findSection(emoji[currentKey].name);
            if (newSection != null) {
                currentSection = newSection;
                currentSection.keys = [];
            }

            /* Create the key */
            const label = emoji[currentKey].char + String.fromCharCode(0xFE0F);
            currentSection.keys.push({label, variants});
            currentKey = i;
            variants = [];
        }
    }

    _createBottomRow() {
        const row = new KeyContainer();
        let key;

        row.appendRow();

        key = new Key({label: 'ABC', hasAction: true}, []);
        key.keyButton.add_style_class_name('default-key');
        key.connect('released', () => this.emit('toggle'));
        row.appendKey(key, 1.5);

        for (let i = 0; i < this._sections.length; i++) {
            const section = this._sections[i];

            key = new Key({label: section.label}, []);
            key.connect('released', () => this._emojiPager.setCurrentSection(section, 0));
            row.appendKey(key);

            section.button = key;
        }

        key = new Key({iconName: 'osk-hide-symbolic', hasAction: true});
        key.keyButton.add_style_class_name('default-key');
        key.keyButton.add_style_class_name('hide-key');
        key.connect('released', () => {
            this.emit('close-request');
        });
        row.appendKey(key);

        const actor = new AspectContainer({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        actor.add_child(row);

        return actor;
    }

    /**
     * @param {[number, number]} ratio
     */
    set ratio(ratio) {
        const [nCols, nRows] = ratio;
        this._emojiPager.ratio = [Math.floor(nCols), Math.floor(nRows) - 1];
        this._bottomRow.ratio = [nCols, 1];
        // (Re)attach actors so the emoji panel fits the ratio and
        // the bottom row is ensured to take 1 row high.
        if (this._pagerBox.get_parent())
            this.remove_child(this._pagerBox);
        if (this._bottomRow.get_parent())
            this.remove_child(this._bottomRow);

        this._gridLayout.attach(this._pagerBox, 0, 0, 1, Math.floor(nRows) - 1);
        this._gridLayout.attach(this._bottomRow, 0, Math.floor(nRows) - 1, 1, 1);
    }
});

export class KeyboardManager extends Signals.EventEmitter {
    constructor() {
        super();

        this._keyboard = null;
        this._a11yApplicationsSettings = new Gio.Settings({schema_id: A11Y_APPLICATIONS_SCHEMA});
        this._a11yApplicationsSettings.connect('changed', this._syncEnabled.bind(this));

        this._seat = global.stage.context.get_backend().get_default_seat();
        this._seat.connect('notify::touch-mode', this._syncEnabled.bind(this));

        this._lastDevice = null;
        global.backend.connect('last-device-changed', (backend, device) => {
            if (device.device_type === Clutter.InputDeviceType.KEYBOARD_DEVICE)
                return;

            this._lastDevice = device;
            this._syncEnabled();
        });

        const allowedModes = Shell.ActionMode.ALL & ~Shell.ActionMode.LOCK_SCREEN;
        const bottomDragGesture = new Shell.EdgeDragGesture({
            name: 'OSK show bottom drag',
            // @ts-expect-error The generated constructor uses the wrong enum
            side: St.Side.BOTTOM,
        });
        bottomDragGesture.connect('may-recognize', () => {
            return allowedModes & Main.actionMode;
        });
        bottomDragGesture.connect('progress', (_action, progress) => {
            this._keyboard?.gestureProgress(progress);
        });
        bottomDragGesture.connect('end', () => {
            this._keyboard?.gestureActivate();
        });
        bottomDragGesture.connect('cancel', () => {
            this._keyboard?.gestureCancel();
        });
        global.stage.add_action(bottomDragGesture);
        this._bottomDragGesture = bottomDragGesture;

        this._syncEnabled();
    }

    _lastDeviceIsTouchscreen() {
        if (!this._lastDevice)
            return false;

        const deviceType = this._lastDevice.get_device_type();
        return deviceType === Clutter.InputDeviceType.TOUCHSCREEN_DEVICE;
    }

    _syncEnabled() {
        const enableKeyboard = this._a11yApplicationsSettings.get_boolean(SHOW_KEYBOARD);
        const autoEnabled = this._seat.get_touch_mode() && this._lastDeviceIsTouchscreen();
        const enabled = enableKeyboard || autoEnabled;

        if (!enabled && !this._keyboard)
            return;

        if (enabled && !this._keyboard) {
            this._keyboard = new Keyboard();
            this._keyboard.connect('visibility-changed', () => {
                this.emit('visibility-changed');
                this._bottomDragGesture.enabled = !this._keyboard.visible;
            });
        } else if (!enabled && this._keyboard) {
            this._keyboard.setCursorLocation(null);
            this._keyboard.destroy();
            this._keyboard = null;
            this._bottomDragGesture.enabled = true;
        }
    }

    get keyboardActor() {
        return this._keyboard;
    }

    get visible() {
        return this._keyboard && this._keyboard.visible;
    }

    /** @param {number} monitor */
    open(monitor) {
        Main.layoutManager.keyboardIndex = monitor;

        if (this._keyboard)
            this._keyboard.open();
    }

    close() {
        if (this._keyboard)
            this._keyboard.close();
    }

    /**
     * @param {string} text
     * @param {() => void} callback
     */
    addSuggestion(text, callback) {
        if (this._keyboard)
            this._keyboard.addSuggestion(text, callback);
    }

    resetSuggestions() {
        if (this._keyboard)
            this._keyboard.resetSuggestions();
    }

    /** @param {boolean} visible */
    setSuggestionsVisible(visible) {
        this._keyboard?.setSuggestionsVisible(visible);
    }
}
/** @typedef {InstanceType<typeof KeyContainer>} KeyContainer */
/** @typedef {InstanceType<typeof AspectContainer>} AspectContainer */

const KEYBOARD_SIDES = /** @type {const} */ (["left", "right"])
/**
 * @typedef {(typeof KEYBOARD_SIDES)[number]} KeyboardSide
 */

/**
 * @typedef {{
 *   keyContainers: Record<string, KeyContainer>,
 *   keyContainerWrapper: St.Widget,
 *   resizeHandle: St.Widget
 * }} SplitKeyboardSideState
 */

/**
 * @typedef {{
 *   mode: 'centered',
 *   aspectContainer: AspectContainer,
 *   currentLayout: Clutter.Actor | null,
 *   layers: Record<string, KeyContainer>,
 *   currentPage: KeyContainer | null
 * }} CenteredKeyboardLayoutState
 */

/**
 * @typedef {{
 *   mode: 'split',
 *   elements: {
 *     layoutContainer: St.Widget,
 *     splitContainer: St.BoxLayout,
 *     emojiContainer: AspectContainer,
 *     keyContainers: Record<KeyboardSide, SplitKeyboardSideState>
 *   },
 *   sideSize: number,
 *   currentLevel: string | null,
 *   resizeStartX: number,
 *   resizeStartSize: number,
 *   resizeGrab: Clutter.Grab | null,
 *   resizeKeyFocus: Clutter.Actor | null,
 *   resizing: boolean
 * }} SplitKeyboardLayoutState
 */

/**
 * @typedef {CenteredKeyboardLayoutState | SplitKeyboardLayoutState} KeyboardLayoutModeDependentState
 */
export const Keyboard = GObject.registerClass({
    Signals: {
        'visibility-changed': {},
    },
}, class Keyboard extends St.BoxLayout {
    constructor() {
        super({
            name: 'keyboard',
            reactive: true,
            // Keyboard models are defined in LTR, we must override
            // the locale setting in order to avoid flipping the
            // keyboard on RTL locales.
            text_direction: Clutter.TextDirection.LTR,
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._focusInOsk = false;
        this._emojiActive = false;

        this._languagePopup = null;
        this._settingsPopup = null;
        this._settingsPopupOpenStateId = 0;
        this._settingsPopupInteraction = false;
        this._settingsPopupKeyFocus = null;
        this._settingsPopupRestoringFocusId = 0;
        /** @type {Meta.Window | null} */
        this._focusWindow = null;
        this._focusWindowStartY = null;

        this._latched = false; // current level is latched
        this._modifiers = new Set();
        /** @type {Map<number, InstanceType<typeof Key>[]>} */
        this._modifierKeys = new Map();

        this._suggestions = null;

        this._focusTracker = new FocusTracker();
        this._focusTracker.connectObject(
            'position-changed', this._onFocusPositionChanged.bind(this),
            'window-grabbed', this._onFocusWindowMoving.bind(this), this);

        this._windowMovedId = this._focusTracker.connect('window-moved',
            this._onFocusWindowMoving.bind(this));

        this._showIdleId = 0;

        this._keyboardVisible = false;
        this._keyboardRequested = false;
        this._keyboardRestingId = 0;

        this._settings = new Gio.Settings({schema_id: SHELL_SCHEMA});
        this._seat = global.stage.context.get_backend().get_default_seat();

        Main.layoutManager.connectObject('monitors-changed',
            this._onMonitorsChanged.bind(this), this);

        this._setupKeyboard();

        this._settings.connectObject(
            `changed::${SPLIT_KEYBOARD_ENABLED}`,
            this._syncLayoutMode.bind(this),
            `changed::${SPLIT_KEYBOARD_SIDE_SIZE}`,
            this._syncSplitKeyboardSideSize.bind(this),
            this);
        this._seat.connectObject(
            'device-added', this._syncLayoutMode.bind(this),
            'device-removed', this._syncLayoutMode.bind(this),
            this);

        this.connect('destroy', this._onDestroy.bind(this));
    }

    get visible() {
        return this._keyboardVisible && super.visible;
    }

    set visible(visible) {
        super.visible = visible;
    }

    /** @param {FocusTracker} focusTracker */
    _onFocusPositionChanged(focusTracker) {
        const rect = focusTracker.currentRect;
        this.setCursorLocation(focusTracker.currentWindow, rect.x, rect.y, rect.width, rect.height);
        this._updateLevelFromHints(true);
    }

    _onDestroy() {
        if (this._windowMovedId) {
            this._focusTracker.disconnect(this._windowMovedId);
            delete this._windowMovedId;
        }

        if (this._focusTracker) {
            this._focusTracker.destroy();
            delete this._focusTracker;
        }

        this._clearShowIdle();

        if (this._settingsPopupRestoringFocusId) {
            GLib.source_remove(this._settingsPopupRestoringFocusId);
            this._settingsPopupRestoringFocusId = 0;
        }

        this._keyboardController.setOskCompletion(false);
        this._keyboardController.destroy();

        Main.layoutManager.untrackChrome(this);
        Main.layoutManager.keyboardBox.remove_child(this);
        Main.layoutManager.keyboardBox.hide();

        if (this._languagePopup) {
            this._languagePopup.destroy();
            this._languagePopup = null;
        }

        if (this._settingsPopup) {
            if (this._settingsPopupOpenStateId)
                this._settingsPopup.disconnect(this._settingsPopupOpenStateId);
            this._settingsPopup.destroy();
            this._settingsPopup = null;
            this._settingsPopupOpenStateId = 0;
        }

        if (this._layoutState.mode === 'split') {
            this._layoutState.resizeGrab?.dismiss();
            this._layoutState.resizeGrab = null;
        }
    }

    _setupKeyboard() {
        Main.layoutManager.keyboardBox.add_child(this);
        Main.layoutManager.trackChrome(this);

        this._keyboardController = new KeyboardController();

        this._suggestions = new Suggestions();
        this._suggestions.connect('settings-requested', () => {
            this._popupKeyboardSettings(this._suggestions.settingsButton);
        });
        this.add_child(this._suggestions);

        /** @type {KeyboardLayoutModeDependentState} */
        this._layoutState = this._shouldUseSplitLayout()
            ? this._createSplitLayoutState()
            : this._createCenteredLayoutState();

        this._emojiSelection = new EmojiSelection();
        this._emojiSelection.connect('toggle', this._toggleEmoji.bind(this));
        this._emojiSelection.connect('close-request', () => this.close(true));
        this._emojiSelection.connect('emoji-selected', (selection, emoji) => {
            this._keyboardController.commit(emoji).catch(console.error);
        });

        this._emojiSelection.hide();
        this._addEmojiSelectionToLayout();

        this._updateKeys();

        this._keyboardController.connectObject(
            'group-changed', this._onGroupChanged.bind(this),
            'panel-state', this._onKeyboardStateChanged.bind(this),
            'purpose-changed', () => this._updateKeys(),
            'content-hints-changed', this._onContentHintsChanged.bind(this),
            this);
        global.stage.connectObject('notify::key-focus',
            this._onKeyFocusChanged.bind(this), this);

        this._relayout();
    }

    _onMonitorsChanged() {
        this._relayout();
        this._syncLayoutMode();
    }

    /** @returns {Clutter.InputDevice[]} */
    _getTouchscreens() {
        return this._seat.list_devices().filter(device =>
            device.get_device_type() ===
                Clutter.InputDeviceType.TOUCHSCREEN_DEVICE);
    }

    /** @returns {number | null} */
    _getTouchscreenPhysicalWidth() {
        const monitor = Main.layoutManager.keyboardMonitor;
        if (!monitor)
            return null;

        const monitorIsLandscape = monitor.width >= monitor.height;
        const monitorAspectRatio = monitor.width / monitor.height;
        let bestMatch = null;
        let bestAspectRatioDifference = Number.POSITIVE_INFINITY;

        for (const device of this._getTouchscreens()) {
            const [hasDimensions, width, height] = device.get_dimensions();
            if (!hasDimensions || width <= 0 || height <= 0)
                continue;

            const deviceIsLandscape = width >= height;
            const physicalWidth = monitorIsLandscape === deviceIsLandscape
                ? width
                : height;
            const physicalHeight = monitorIsLandscape === deviceIsLandscape
                ? height
                : width;
            const aspectRatioDifference = Math.abs(
                monitorAspectRatio - physicalWidth / physicalHeight);

            if (aspectRatioDifference < bestAspectRatioDifference) {
                bestMatch = physicalWidth;
                bestAspectRatioDifference = aspectRatioDifference;
            }
        }

        return bestMatch;
    }

    _shouldUseSplitLayout() {
        if (this._getTouchscreens().length === 0)
            return false;

        if (this._settings.get_boolean(SPLIT_KEYBOARD_ENABLED))
            return true;

        const physicalWidth = this._getTouchscreenPhysicalWidth();
        return physicalWidth !== null &&
            physicalWidth / 2 > SPLIT_KEYBOARD_MAX_REACH_MM;
    }

    _syncLayoutMode() {
        if (!this._layoutState || !this._emojiSelection)
            return;

        const useSplitLayout = this._shouldUseSplitLayout();
        if ((this._layoutState.mode === 'split') === useSplitLayout)
            return;

        const emojiParent = this._emojiSelection.get_parent();
        emojiParent?.remove_child(this._emojiSelection);

        if (this._layoutState.mode === 'centered') {
            this._layoutState.aspectContainer.destroy();
        } else {
            this._layoutState.resizeGrab?.dismiss();
            this._layoutState.elements.layoutContainer.destroy();
        }

        this._layoutState = useSplitLayout
            ? this._createSplitLayoutState()
            : this._createCenteredLayoutState();
        this._addEmojiSelectionToLayout();
        this._relayout();
        this._updateKeys();
        this._updateCurrentPageVisible();
    }

    /** @param {Clutter.Actor} sourceActor */
    _popupKeyboardSettings(sourceActor) {
        if (this._settingsPopupRestoringFocusId) {
            GLib.source_remove(this._settingsPopupRestoringFocusId);
            this._settingsPopupRestoringFocusId = 0;
        }

        if (this._settingsPopup) {
            if (this._settingsPopupOpenStateId)
                this._settingsPopup.disconnect(this._settingsPopupOpenStateId);
            this._settingsPopup.destroy();
            this._settingsPopupOpenStateId = 0;
        }

        const keyFocus = global.stage.key_focus;
        this._settingsPopupKeyFocus = keyFocus instanceof Clutter.Text
            ? keyFocus
            : null;
        this._settingsPopupInteraction = true;

        this._settingsPopup = new KeyboardSettingsPopup(
            sourceActor, this._settings, this._getTouchscreens().length > 0);
        this._settingsPopupOpenStateId = this._settingsPopup.connect(
            'open-state-changed', (_popup, isOpen) => {
                if (isOpen)
                    return;

                if (this._settingsPopupKeyFocus?.is_mapped())
                    this._settingsPopupKeyFocus.grab_key_focus();
                this._settingsPopupKeyFocus = null;

                this._settingsPopupRestoringFocusId = GLib.idle_add_once(
                    GLib.PRIORITY_DEFAULT_IDLE, () => {
                        this._settingsPopupInteraction = false;
                        this._settingsPopupRestoringFocusId = 0;
                    });
            });
        Main.layoutManager.addTopChrome(this._settingsPopup.actor);
        this._settingsPopup.open(BoxPointer.PopupAnimation.FULL);
    }

    _syncSplitKeyboardSideSize() {
        if (this._layoutState.mode !== 'split' ||
            this._layoutState.resizing)
            return;

        this.splitKeyboardSideSize =
            this._settings.get_int(SPLIT_KEYBOARD_SIDE_SIZE);
    }

    /** @returns {CenteredKeyboardLayoutState} */
    _createCenteredLayoutState() {
        const aspectContainer = new AspectContainer({
            layout_manager: new Clutter.BinLayout(),
            y_expand: true,
        });
        this.add_child(aspectContainer);

        return {
            mode: 'centered',
            aspectContainer,
            currentLayout: null,
            layers: {},
            currentPage: null,
        };
    }

    set splitKeyboardSideSize(/** @type {number} */ size) {
        const state = this._layoutState;
        if (state.mode !== 'split')
            throw new Error('Cannot set splitKeyboardSideSize when layout is not split');

        const availableWidth = this.width || state.elements.splitContainer.width;
        const reservedWidth =
            SPLIT_KEYBOARD_MIN_GAP + SPLIT_KEYBOARD_HANDLE_WIDTH * 2;
        const maximumSize = availableWidth > 0
            ? Math.max(0, (availableWidth - reservedWidth) / 2)
            : size;
        const minimumSize = Math.min(SPLIT_KEYBOARD_MIN_SIDE_SIZE, maximumSize);

        state.sideSize = Math.round(
            Math.clamp(size, minimumSize, maximumSize));
        state.elements.keyContainers.left.keyContainerWrapper.minWidth = state.sideSize;
        state.elements.keyContainers.right.keyContainerWrapper.minWidth = state.sideSize;
        state.elements.keyContainers.left.keyContainerWrapper.width = state.sideSize;
        state.elements.keyContainers.right.keyContainerWrapper.width = state.sideSize;
    }

    get splitKeyboardSideSize() {
        if (this._layoutState.mode !== 'split')
            throw new Error('Cannot get splitKeyboardSideSize when layout is not split');
        return this._layoutState.sideSize;
    }

    /**
     * @returns {SplitKeyboardLayoutState}
     */
    _createSplitLayoutState() {
        const sideSize = this._settings.get_int(SPLIT_KEYBOARD_SIDE_SIZE);
        const layoutContainer = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        const splitContainer = new St.BoxLayout({
            orientation: Clutter.Orientation.HORIZONTAL,
            style_class: 'keyboard-split-container',
            x_expand: true,
            y_expand: true,
        });
        const emojiContainer = new AspectContainer({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        const leftContainerWrapper = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'keyboard-split-key-container keyboard-split-container-left',
            x_expand: false,
            y_expand: true,
            width: sideSize,
        });
        const rightContainerWrapper = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            style_class: 'keyboard-split-key-container keyboard-split-container-right',
            x_expand: false,
            y_expand: true,
            width: sideSize,
        });
        const leftResizeHandle = this._createSplitResizeHandle('left');
        const rightResizeHandle = this._createSplitResizeHandle('right');

        splitContainer.add_child(leftContainerWrapper);
        splitContainer.add_child(leftResizeHandle);
        splitContainer.add_child(new St.Widget({x_expand: true}));
        splitContainer.add_child(rightResizeHandle);
        splitContainer.add_child(rightContainerWrapper);
        layoutContainer.add_child(splitContainer);
        layoutContainer.add_child(emojiContainer);
        this.add_child(layoutContainer);

        /** @type {SplitKeyboardLayoutState} */
        const state = {
            mode: 'split',
            elements: {
                layoutContainer,
                splitContainer,
                emojiContainer,
                keyContainers: {
                    left: {
                        keyContainers: {},
                        keyContainerWrapper: leftContainerWrapper,
                        resizeHandle: leftResizeHandle,
                    },
                    right: {
                        keyContainers: {},
                        keyContainerWrapper: rightContainerWrapper,
                        resizeHandle: rightResizeHandle,
                    },
                },
            },
            sideSize,
            currentLevel: null,
            resizeStartX: 0,
            resizeStartSize: sideSize,
            resizeGrab: null,
            resizeKeyFocus: null,
            resizing: false,
        };

        this._addSplitResizeGesture(state, 'left');
        this._addSplitResizeGesture(state, 'right');

        return state;
    }

    /** @param {KeyboardSide} side */
    _createSplitResizeHandle(side) {
        const handle = new St.Widget({
            accessible_name: _('Resize Keyboard'),
            can_focus: false,
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            style_class: `keyboard-resize-handle handle-${side}`,
            y_align: Clutter.ActorAlign.CENTER,
            width: SPLIT_KEYBOARD_HANDLE_WIDTH,
            height: SPLIT_KEYBOARD_HANDLE_WIDTH,
        });
        handle.add_child(new St.Icon({
            icon_name: side === 'left'
                ? 'go-next-symbolic'
                : 'go-previous-symbolic',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            width: SPLIT_KEYBOARD_HANDLE_WIDTH / 2,
            height: SPLIT_KEYBOARD_HANDLE_WIDTH / 2,
        }));
        return handle;
    }

    /**
     * @param {SplitKeyboardLayoutState} state
     * @param {KeyboardSide} side
     */
    _addSplitResizeGesture(state, side) {
        const handle = state.elements.keyContainers[side].resizeHandle;
        const gesture = new Clutter.PanGesture();
        gesture.set_begin_threshold(0);
        gesture.connect('may-recognize', () => {
            if (!state.resizing)
                state.resizeKeyFocus = global.stage.key_focus;
            state.resizing = true;
            return true;
        });
        gesture.connect('recognize', () => {
            state.resizeGrab?.dismiss();
            state.resizeStartX = gesture.get_centroid_abs().x;
            state.resizeStartSize = state.sideSize;
            state.resizeGrab = global.stage.grab(handle);
            state.elements.splitContainer.add_style_class_name(
                'keyboard-split-resizing');
        });
        gesture.connect('pan-update', () => {
            const delta = gesture.get_centroid_abs().x - state.resizeStartX;
            const direction = side === 'left' ? 1 : -1;
            this.splitKeyboardSideSize =
                state.resizeStartSize + delta * direction;
        });
        const endGesture = () => {
            state.resizeGrab?.dismiss();
            state.resizeGrab = null;
            state.resizing = false;
            state.elements.splitContainer.remove_style_class_name(
                'keyboard-split-resizing');
            this._settings.set_int(
                SPLIT_KEYBOARD_SIDE_SIZE, Math.round(state.sideSize));

            const {resizeKeyFocus} = state;
            state.resizeKeyFocus = null;
            if (resizeKeyFocus?.is_mapped())
                resizeKeyFocus.grab_key_focus();
        };
        gesture.connect('end', endGesture);
        gesture.connect('cancel', endGesture);
        handle.add_action(gesture);
    }

    _addEmojiSelectionToLayout() {
        const state = this._layoutState;
        switch (state.mode) {
        case 'centered':
            state.aspectContainer.add_child(this._emojiSelection);
            break;
        case 'split':
            state.elements.emojiContainer.add_child(this._emojiSelection);
            break;
        }
    }

    _shouldShowEmoji() {
        if ((this._contentHints & Clutter.InputContentHintFlags.NO_EMOJI) !== 0)
            return false;

        const {purpose} = this._keyboardController;
        return purpose === Clutter.InputContentPurpose.NORMAL ||
            purpose === Clutter.InputContentPurpose.ALPHA ||
            purpose === Clutter.InputContentPurpose.PASSWORD ||
            purpose === Clutter.InputContentPurpose.TERMINAL;
    }

    /**
     * @param {KeyboardController} controller
     * @param {Clutter.InputContentHintFlags} contentHints
     */
    _onContentHintsChanged(controller, contentHints) {
        this._contentHints = contentHints;

        if (this.visible &&
            (contentHints & Clutter.InputContentHintFlags.INHIBIT_OSK) !== 0) {
            this.close();
        } else {
            const emojiVisible = this._shouldShowEmoji();
            if (emojiVisible !== this._emojiVisible)
                this._updateKeys();
            else
                this._updateLevelFromHints(false);
        }
    }

    /** @param {boolean} userInputHappened */
    _updateLevelFromHints(userInputHappened) {
        // If the latch is enabled, avoid level changes
        if (this._latched)
            return;

        if ((this._contentHints & Clutter.InputContentHintFlags.LOWERCASE) !== 0) {
            this._setActiveLevel('default');
            return;
        }

        if (!this._hasLevel('shift'))
            return;

        if ((this._contentHints & Clutter.InputContentHintFlags.UPPERCASE) !== 0) {
            this._setActiveLevel('shift');
            return;
        }

        if ((this._contentHints &
             (Clutter.InputContentHintFlags.AUTO_CAPITALIZATION |
              Clutter.InputContentHintFlags.TITLECASE)) !== 0) {
            if (this._surroundingTextId)
                return;

            this._surroundingTextId =
                Main.inputMethod.connect('surrounding-text-set', () => {
                    const [text, cursor] = Main.inputMethod.getSurroundingText();
                    if (!text || cursor === 0) {
                        // First character in the buffer
                        this._setActiveLevel('shift');
                        return;
                    }

                    const beforeCursor = GLib.utf8_substring(text, 0, cursor);

                    if ((this._contentHints & Clutter.InputContentHintFlags.TITLECASE) !== 0) {
                        if (beforeCursor.charAt(beforeCursor.length - 1) === ' ')
                            this._setActiveLevel('shift');
                        else
                            this._setActiveLevel('default');
                    } else if ((this._contentHints & Clutter.InputContentHintFlags.AUTO_CAPITALIZATION) !== 0) {
                        if (beforeCursor.charAt(beforeCursor.trimEnd().length - 1) === '.')
                            this._setActiveLevel('shift');
                        else
                            this._setActiveLevel('default');
                    }

                    Main.inputMethod.disconnect(this._surroundingTextId);
                    this._surroundingTextId = 0;
                });
            Main.inputMethod.request_surrounding();
            return;
        }

        if (userInputHappened && this._isActiveLevel('shift'))
            this._setActiveLevel('default');
    }

    /** @param {string} level */
    _hasLevel(level) {
        const state = this._layoutState;
        switch (state.mode) {
        case 'centered':
            return !!state.layers[level];
        case 'split':
            return !!state.elements.keyContainers.left.keyContainers[level] &&
                !!state.elements.keyContainers.right.keyContainers[level];
        }
        return false;
    }

    /** @param {string} level */
    _isActiveLevel(level) {
        const state = this._layoutState;
        switch (state.mode) {
        case 'centered':
            return state.currentPage === state.layers[level];
        case 'split':
            return state.currentLevel === level;
        }
        return false;
    }

    _onKeyFocusChanged() {
        const focus = global.stage.key_focus;

        // Interacting with OSK controls may temporarily move key focus away
        // from the text actor, but must not close the keyboard.
        const focusWasInOsk = this._focusInOsk;
        /**
         * @type {Clutter.Actor & { _extendedKeys?: Clutter.Actor, extendedKey?: string }}
         */
        const keyFocus = focus;
        this._focusInOsk = Boolean(keyFocus &&
            (keyFocus._extendedKeys ||
             keyFocus.extendedKey ||
             this._settingsPopup?.actor.contains(keyFocus) ||
             this._isSplitResizeHandle(keyFocus)));
        const resizing = this._layoutState.mode === 'split' &&
            this._layoutState.resizing;
        if (this._focusInOsk || focusWasInOsk || resizing ||
            this._settingsPopupInteraction)
            return;

        if (!(focus instanceof Clutter.Text)) {
            this.close();
            return;
        }

        if (!this._showIdleId) {
            this._showIdleId = GLib.idle_add_once(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this.open(Boolean(Main.layoutManager.focusIndex));
                this._showIdleId = 0;
            });
            GLib.Source.set_name_by_id(this._showIdleId, '[gnome-shell] this.open');
        }
    }

    /** @param {Clutter.Actor} actor */
    _isSplitResizeHandle(actor) {
        const state = this._layoutState;
        if (state.mode !== 'split')
            return false;

        return Object.values(state.elements.keyContainers).some(
            ({resizeHandle}) =>
                actor === resizeHandle || resizeHandle.contains(actor));
    }

    /**
     * @param {string} groupName
     * @param {Clutter.InputContentPurpose} purpose
     */
    _updateLayout(groupName, purpose) {
        let keyboardModel = null;

        if (purpose === Clutter.InputContentPurpose.DIGITS) {
            keyboardModel = new KeyboardModel('digits');
        } else if (purpose === Clutter.InputContentPurpose.NUMBER) {
            keyboardModel = new KeyboardModel('number');
        } else if (purpose === Clutter.InputContentPurpose.PHONE) {
            keyboardModel = new KeyboardModel('phone');
        } else if (purpose === Clutter.InputContentPurpose.EMAIL) {
            keyboardModel = new KeyboardModel('email');
        } else if (purpose === Clutter.InputContentPurpose.URL) {
            keyboardModel = new KeyboardModel('url');
        } else {
            let groups = [groupName];
            if (groupName.includes('+'))
                groups.push(groupName.replace(/\+.*/, ''));
            groups.push('us');

            if (purpose === Clutter.InputContentPurpose.TERMINAL)
                groups = groups.map(g => `${g}-extended`);

            for (const group of groups) {
                try {
                    keyboardModel = new KeyboardModel(group);
                    break;
                } catch {
                    // Ignore this error and fall back to next model
                }
            }

            if (!keyboardModel)
                return;
        }

        this._emojiVisible = this._shouldShowEmoji();

        const state = this._layoutState;
        switch (state.mode) {
        case 'centered':
            this._updateCenteredLayout(state, keyboardModel);
            break;
        case 'split':
            this._updateSplitLayout(state, keyboardModel);
            break;
        }
    }

    /**
     * @param {CenteredKeyboardLayoutState} state
     * @param {KeyboardModel} keyboardModel
     */
    _updateCenteredLayout(state, keyboardModel) {
        /** @type {Record<string, InstanceType<typeof KeyContainer>>} */
        const layers = {};
        const layout = new Clutter.Actor({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });

        keyboardModel.levels.forEach(currentLevel => {
            const levelLayout = new KeyContainer();
            levelLayout.shiftKeys = [];
            levelLayout.mode = currentLevel.mode;

            const rows = currentLevel.rows;
            rows.forEach(row => {
                levelLayout.appendRow();
                this._addRowKeys(row, levelLayout, this._emojiVisible);
            });

            layers[currentLevel.level] = levelLayout;
            layout.add_child(levelLayout);
            levelLayout.hide();
        });

        state.aspectContainer.add_child(layout);
        state.currentLayout?.destroy();
        state.currentLayout = layout;
        state.layers = layers;
    }

    /**
     * @param {SplitKeyboardLayoutState} state
     * @param {KeyboardModel} keyboardModel
     */
    _updateSplitLayout(state, keyboardModel) {
        state.currentLevel = null;

        for (const side of KEYBOARD_SIDES) {
            const sideState = state.elements.keyContainers[side];

            for (const keyContainer of Object.values(sideState.keyContainers))
                keyContainer.destroy();
            sideState.keyContainers = {};
        }

        keyboardModel.levels.forEach(currentLevel => {
            const splitRows = currentLevel.rows.map(row => this._splitRow(row));
            const gridWidth = splitRows.reduce((maximumWidth, [left, right]) =>
                Math.max(maximumWidth,
                    this._getRowWidth(left),
                    this._getRowWidth(right)), 0);

            const leftLayout = new KeyContainer();
            const rightLayout = new KeyContainer();
            leftLayout.mode = currentLevel.mode;
            rightLayout.mode = currentLevel.mode;

            for (const [left, right] of splitRows) {
                leftLayout.appendRow();
                rightLayout.appendRow();

                this._addRowKeys(left, leftLayout, this._emojiVisible);
                this._addRowKeys(
                    this._alignSplitRowToEnd(right, gridWidth),
                    rightLayout,
                    this._emojiVisible);
            }

            leftLayout.ensureGridWidth(gridWidth);
            rightLayout.ensureGridWidth(gridWidth);
            leftLayout.hide();
            rightLayout.hide();

            state.elements.keyContainers.left.keyContainers[currentLevel.level] =
                leftLayout;
            state.elements.keyContainers.right.keyContainers[currentLevel.level] =
                rightLayout;
            state.elements.keyContainers.left.keyContainerWrapper.add_child(
                leftLayout);
            state.elements.keyContainers.right.keyContainerWrapper.add_child(
                rightLayout);
        });
    }

    /**
     * @param {LayoutKey[]} row
     * @returns {[LayoutKey[], LayoutKey[]]}
     */
    _splitRow(row) {
        const spaceIndex = row.findIndex(key => key.strings?.[0] === ' ');
        if (spaceIndex >= 0) {
            const spaceKey = row[spaceIndex];
            const spaceWidth = (spaceKey.width ?? 1) / 2;
            return [
                [
                    ...row.slice(0, spaceIndex).map(key => this._cloneLayoutKey(key)),
                    this._cloneLayoutKey(spaceKey, spaceWidth),
                ],
                [
                    this._cloneLayoutKey(spaceKey, spaceWidth, 0),
                    ...row.slice(spaceIndex + 1).map(key => this._cloneLayoutKey(key)),
                ],
            ];
        }

        if (row.length <= 1)
            return [row.map(key => this._cloneLayoutKey(key)), []];

        // Non-character keys generally sit at the outside edges of a row and
        // may be wider than character keys. Including them in the midpoint
        // would pull characters onto the left half just because a row ends in
        // a wide Backspace or Enter key.
        const inputWidth = row.reduce((width, key) =>
            width + (key.strings ? key.width ?? 1 : 0), 0);
        const midpoint = inputWidth / 2;
        let splitIndex = 1;
        let position = 0;
        let nearestDistance = Number.POSITIVE_INFINITY;

        for (let i = 0; i < row.length - 1; i++) {
            const key = row[i];
            position += key.strings ? key.width ?? 1 : 0;
            const distance = Math.abs(midpoint - position);
            // For an odd number of equally-sized input keys, prefer the left
            // half for the extra key (ASDFG | HJKL, for example).
            if (distance <= nearestDistance) {
                nearestDistance = distance;
                splitIndex = i + 1;
            }
        }

        return [
            row.slice(0, splitIndex).map(key => this._cloneLayoutKey(key)),
            row.slice(splitIndex).map(key => this._cloneLayoutKey(key)),
        ];
    }

    /**
     * @param {LayoutKey} key
     * @param {number} [width]
     * @param {number} [leftOffset]
     * @returns {LayoutKey}
     */
    _cloneLayoutKey(key, width = key.width, leftOffset = key.leftOffset) {
        return {
            ...key,
            strings: key.strings ? [...key.strings] : undefined,
            width,
            leftOffset,
        };
    }

    /** @param {LayoutKey} key */
    _getKeyWidth(key) {
        return (key.leftOffset ?? 0) + (key.width ?? 1);
    }

    /** @param {LayoutKey[]} row */
    _getRowWidth(row) {
        return row.reduce((width, key) => width + this._getKeyWidth(key), 0);
    }

    /**
     * @param {LayoutKey[]} row
     * @param {number} gridWidth
     * @returns {LayoutKey[]}
     */
    _alignSplitRowToEnd(row, gridWidth) {
        if (row.length === 0)
            return row;

        const leadingOffset = gridWidth - this._getRowWidth(row);
        if (leadingOffset <= 0)
            return row;

        const [firstKey, ...remainingKeys] = row;
        return [
            this._cloneLayoutKey(
                firstKey,
                firstKey.width,
                (firstKey.leftOffset ?? 0) + leadingOffset),
            ...remainingKeys,
        ];
    }

    /**
     * @param {LayoutKey[]} keys
     * @param {InstanceType<typeof KeyContainer>} layout
     * @param {boolean} emojiVisible
     */
    _addRowKeys(keys, layout, emojiVisible) {
        let accumulatedWidth = 0;
        for (let i = 0; i < keys.length; ++i) {
            const key = keys[i];
            const {strings} = key;
            const commitString = strings?.shift();
            const keyval = key.keyval ? parseInt(key.keyval, 16) : 0;

            if (key.action === 'emoji' && !emojiVisible) {
                accumulatedWidth = key.width ?? 1;
                continue;
            }

            if (accumulatedWidth > 0) {
                // Pass accumulated width onto the next key
                key.width = (key.width ?? 1) + accumulatedWidth;
                accumulatedWidth = 0;
            }

            const button = new Key({
                commitString,
                label: key.label,
                iconName: key.iconName,
                keyval: key.keyval,
                hasAction: !!key.action,
            }, strings);

            if (key.action) {
                button.connect('released', () => {
                    if (key.action === 'hide') {
                        this.close(true);
                        this._updateLevelFromHints(true);
                    } else if (key.action === 'languageMenu') {
                        this._popupLanguageMenu(button);
                    } else if (key.action === 'emoji') {
                        this._toggleEmoji();
                    } else if (key.action === 'modifier') {
                        this._toggleModifier(keyval);
                    } else if (key.action === 'delete') {
                        this._keyboardController.toggleDelete(true);
                        this._keyboardController.toggleDelete(false);
                        this._updateLevelFromHints(true);
                    } else if (!this._longPressed && key.action === 'levelSwitch') {
                        this._setActiveLevel(String(key.level));
                        this._setLatched(
                            key.level === 1 &&
                                key.iconName === 'osk-caps-lock-symbolic');
                    }

                    this._longPressed = false;
                });
            } else if (key.keyval) {
                button.connect('keyval', (_actor, emittedKeyval) => {
                    this._keyboardController.keyvalPress(emittedKeyval);
                    this._keyboardController.keyvalRelease(emittedKeyval);
                    this._updateLevelFromHints(true);
                });
            } else {
                button.connect('commit', (_actor, str) => {
                    this._keyboardController.commit(str, this._modifiers).then(() => {
                        this._disableAllModifiers();
                        this._updateLevelFromHints(true);
                    }).catch(console.error);
                });
            }

            if (key.action === 'levelSwitch' &&
                key.iconName === 'osk-shift-symbolic') {
                layout.shiftKeys.push(button);
                if (key.level === 'shift') {
                    button.connect('long-press', () => {
                        this._setActiveLevel('shift');
                        this._setLatched(true);
                        this._longPressed = true;
                    });
                }
            }

            if (key.action === 'delete') {
                button.connect('long-press',
                    () => this._keyboardController.toggleDelete(true));
            }

            if (key.action === 'modifier') {
                const modifierKeys = this._modifierKeys.get(keyval) || [];
                modifierKeys.push(button);
                this._modifierKeys.set(keyval, modifierKeys);
            }

            if (key.action || key.keyval)
                button.keyButton.add_style_class_name('default-key');

            layout.appendKey(button, key.width, key.height, key.leftOffset);
        }
    }

    /** @param {boolean} latched */
    _setLatched(latched) {
        this._latched = latched;
        this._setActiveLevelLatched(latched);
    }

    /** @param {boolean} latched */
    _setActiveLevelLatched(latched) {
        const state = this._layoutState;
        switch (state.mode) {
        case 'centered':
            if (state.currentPage)
                this._setCurrentLevelLatched(state.currentPage, latched);
            break;
        case 'split': {
            if (!state.currentLevel)
                break;

            for (const side of KEYBOARD_SIDES) {
                const keyContainer =
                    state.elements.keyContainers[side]
                        .keyContainers[state.currentLevel];
                if (keyContainer)
                    this._setCurrentLevelLatched(keyContainer, latched);
            }
            break;
        }
        }
    }

    /**
     * @param {number} keyval
     * @param {boolean} enabled
     */
    _setModifierEnabled(keyval, enabled) {
        if (enabled)
            this._modifiers.add(keyval);
        else
            this._modifiers.delete(keyval);

        for (const key of this._modifierKeys.get(keyval) ?? [])
            key.setLatched(enabled);
    }

    /** @param {number} keyval */
    _toggleModifier(keyval) {
        const isActive = this._modifiers.has(keyval);
        this._setModifierEnabled(keyval, !isActive);
    }

    _disableAllModifiers() {
        for (const keyval of this._modifiers)
            this._setModifierEnabled(keyval, false);
    }

    /** @param {Clutter.Actor} keyActor */
    _popupLanguageMenu(keyActor) {
        if (this._languagePopup)
            this._languagePopup.destroy();

        this._languagePopup = new LanguageSelectionPopup(keyActor);
        Main.layoutManager.addTopChrome(this._languagePopup.actor);
        this._languagePopup.open(BoxPointer.PopupAnimation.FULL);
    }

    _updateCurrentPageVisible() {
        const state = this._layoutState;
        switch (state.mode) {
        case 'centered':
            if (state.currentPage)
                state.currentPage.visible = !this._emojiActive;
            break;
        case 'split': {
            const visible = !this._emojiActive;
            state.elements.splitContainer.visible = visible;

            if (!state.currentLevel)
                break;

            for (const side of KEYBOARD_SIDES) {
                const keyContainer =
                    state.elements.keyContainers[side]
                        .keyContainers[state.currentLevel];
                if (keyContainer)
                    keyContainer.visible = visible;
            }
            break;
        }
        }
    }

    /** @param {boolean} active */
    _setEmojiActive(active) {
        this._emojiActive = active;
        this._emojiSelection.visible = this._emojiActive;
        this._updateCurrentPageVisible();
    }

    _toggleEmoji() {
        this._setEmojiActive(!this._emojiActive);
    }

    /**
     * @param {InstanceType<typeof KeyContainer>} layout
     * @param {boolean} latched
     */
    _setCurrentLevelLatched(layout, latched) {
        for (let i = 0; i < layout.shiftKeys.length; i++) {
            const key = layout.shiftKeys[i];
            key.setLatched(latched);
            key.iconName = latched
                ? 'osk-caps-lock-symbolic' : 'osk-shift-symbolic';
        }
    }


    _relayout() {
        const monitor = Main.layoutManager.keyboardMonitor;
        const [minHeight] = this.get_preferred_height(-1);

        if (!monitor)
            return;

        this.width = monitor.width;

        if (monitor.width > monitor.height)
            this.height = monitor.height / 3;
        else
            this.height = monitor.height / 4;

        this.height = Math.clamp(this.height, minHeight, monitor.height / 2);

        if (this._layoutState.mode === 'split')
            this.splitKeyboardSideSize = this._layoutState.sideSize;
    }

    _updateKeys() {
        const group = this._keyboardController.getCurrentGroup();
        const {purpose} = this._keyboardController;
        this._disableAllModifiers();
        this._modifierKeys.clear();
        this._updateLayout(group, purpose);
        this._setActiveLevel('default');
    }

    _onGroupChanged() {
        this._updateKeys();
    }

    /**
     * @param {KeyboardController} controller
     * @param {Clutter.InputPanelState} state
     */
    _onKeyboardStateChanged(controller, state) {
        let enabled;
        if (state === Clutter.InputPanelState.OFF)
            enabled = false;
        else if (state === Clutter.InputPanelState.ON)
            enabled = true;
        else if (state === Clutter.InputPanelState.TOGGLE)
            enabled = this._keyboardVisible === false;
        else
            return;

        if (!enabled) {
            const resizing = this._layoutState.mode === 'split' &&
                this._layoutState.resizing;
            if (resizing || this._settingsPopupInteraction)
                return;
        }

        if ((this._contentHints & Clutter.InputContentHintFlags.INHIBIT_OSK) !== 0)
            enabled = false;

        if (enabled)
            this.open(Boolean(Main.layoutManager.focusIndex));
        else
            this.close(true);
    }

    /** @param {string} activeLevel */
    _setActiveLevel(activeLevel) {
        const state = this._layoutState;
        switch (state.mode) {
        case 'centered':
            this._setCenteredActiveLevel(state, activeLevel);
            break;
        case 'split':
            this._setSplitActiveLevel(state, activeLevel);
            break;
        }
    }

    /**
     * @param {CenteredKeyboardLayoutState} state
     * @param {string} activeLevel
     */
    _setCenteredActiveLevel(state, activeLevel) {
        const currentPage = state.layers[activeLevel];

        if (state.currentPage === currentPage) {
            this._updateCurrentPageVisible();
            return;
        }

        if (state.currentPage != null) {
            this._setCurrentLevelLatched(state.currentPage, false);
            state.currentPage.disconnect(state.currentPage._destroyID);
            state.currentPage.hide();
            delete state.currentPage._destroyID;
        }

        this._disableAllModifiers();
        state.currentPage = currentPage;
        state.currentPage._destroyID = state.currentPage.connect('destroy', () => {
            state.currentPage = null;
        });
        this._updateCurrentPageVisible();
        const [columns, rows] = state.currentPage.ratio;
        state.aspectContainer.ratio = [columns, rows];
        this._emojiSelection.ratio = [columns, rows];
    }

    /**
     * @param {SplitKeyboardLayoutState} state
     * @param {string} activeLevel
     */
    _setSplitActiveLevel(state, activeLevel) {
        const leftPage =
            state.elements.keyContainers.left.keyContainers[activeLevel];
        const rightPage =
            state.elements.keyContainers.right.keyContainers[activeLevel];
        if (!leftPage || !rightPage)
            return;

        if (state.currentLevel === activeLevel) {
            this._updateCurrentPageVisible();
            return;
        }

        if (state.currentLevel) {
            const previousLeft = state.elements.keyContainers.left
                .keyContainers[state.currentLevel];
            const previousRight = state.elements.keyContainers.right
                .keyContainers[state.currentLevel];
            if (previousLeft) {
                this._setCurrentLevelLatched(previousLeft, false);
                previousLeft.hide();
            }
            if (previousRight) {
                this._setCurrentLevelLatched(previousRight, false);
                previousRight.hide();
            }
        }

        this._disableAllModifiers();
        state.currentLevel = activeLevel;
        this._updateCurrentPageVisible();

        const columns = leftPage.ratio[0] + rightPage.ratio[0];
        const rows = Math.max(leftPage.ratio[1], rightPage.ratio[1]);
        state.elements.emojiContainer.ratio = [columns, rows];
        this._emojiSelection.ratio = [columns, rows];
    }

    _clearKeyboardRestTimer() {
        if (!this._keyboardRestingId)
            return;
        GLib.source_remove(this._keyboardRestingId);
        this._keyboardRestingId = 0;
    }

    open(immediate = false) {
        this._syncLayoutMode();
        this._clearShowIdle();
        this._keyboardRequested = true;

        if (this._keyboardVisible) {
            this._relayout();
            return;
        }

        this._keyboardController.setOskCompletion(true);
        this._clearKeyboardRestTimer();

        if (immediate) {
            this._open();
            return;
        }

        this._keyboardRestingId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT,
            KEYBOARD_REST_TIME,
            () => {
                this._clearKeyboardRestTimer();
                this._open();
            });
        GLib.Source.set_name_by_id(this._keyboardRestingId, '[gnome-shell] this._clearKeyboardRestTimer');
    }

    _open() {
        if (!this._keyboardRequested)
            return;

        this._relayout();
        this._animateShow();

        this._setEmojiActive(false);
    }

    close(immediate = false) {
        this._clearShowIdle();
        this._keyboardRequested = false;

        if (!this._keyboardVisible)
            return;

        this._keyboardController.setOskCompletion(false);
        this._clearKeyboardRestTimer();

        if (immediate) {
            this._close();
            return;
        }

        this._keyboardRestingId = GLib.timeout_add_once(GLib.PRIORITY_DEFAULT,
            KEYBOARD_REST_TIME,
            () => {
                this._clearKeyboardRestTimer();
                this._close();
            });
        GLib.Source.set_name_by_id(this._keyboardRestingId, '[gnome-shell] this._clearKeyboardRestTimer');
    }

    _close() {
        if (this._keyboardRequested)
            return;

        this._animateHide();
        this.setCursorLocation(null);
        this._disableAllModifiers();
    }

    _animateShow() {
        global.compositor.disable_unredirect();

        if (this._focusWindow)
            this._animateWindow(this._focusWindow, true);

        Main.layoutManager.keyboardBox.show();
        this.ease({
            translation_y: -this.height,
            opacity: 255,
            duration: KEYBOARD_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._animateShowComplete();
            },
        });
        this._keyboardVisible = true;
        this.emit('visibility-changed');
    }

    _animateShowComplete() {
        const keyboardBox = Main.layoutManager.keyboardBox;
        this._keyboardHeightNotifyId = keyboardBox.connect('notify::height', () => {
            this.translation_y = -this.height;
        });
    }

    _animateHide() {
        if (this._focusWindow)
            this._animateWindow(this._focusWindow, false);

        if (this._keyboardHeightNotifyId) {
            Main.layoutManager.keyboardBox.disconnect(this._keyboardHeightNotifyId);
            this._keyboardHeightNotifyId = 0;
        }
        this.ease({
            translation_y: 0,
            opacity: 0,
            duration: KEYBOARD_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this._animateHideComplete();
            },
        });

        this._keyboardVisible = false;
        this.emit('visibility-changed');
    }

    _animateHideComplete() {
        Main.layoutManager.keyboardBox.hide();
        global.compositor.enable_unredirect();
    }

    /** @param {number} delta */
    gestureProgress(delta) {
        this._gestureInProgress = true;
        Main.layoutManager.keyboardBox.show();
        const progress = Math.min(delta, this.height) / this.height;
        this.translation_y = -this.height * progress;
        this.opacity = 255 * progress;
        /** @type {Meta.WindowActor | null} */
        const windowActor = this._focusWindow?.get_compositor_private();
        if (windowActor)
            windowActor.y = this._focusWindowStartY - (this.height * progress);
    }

    gestureActivate() {
        this.open(true);
        this._gestureInProgress = false;
    }

    gestureCancel() {
        if (this._gestureInProgress)
            this._animateHide();
        this._gestureInProgress = false;
    }

    resetSuggestions() {
        if (this._suggestions)
            this._suggestions.clear();
    }

    /** @param {boolean} visible */
    setSuggestionsVisible(visible) {
        this._suggestions?.setVisible(visible);
    }

    /**
     * @param {string} text
     * @param {() => void} callback
     */
    addSuggestion(text, callback) {
        if (!this._suggestions)
            return;
        this._suggestions.add(text, callback);
        this._suggestions.show();
    }

    _clearShowIdle() {
        if (!this._showIdleId)
            return;
        GLib.source_remove(this._showIdleId);
        this._showIdleId = 0;
    }

    /**
     * @param {Meta.Window} window
     * @param {number} finalY
     */
    _windowSlideAnimationComplete(window, finalY) {
        // Synchronize window positions again.
        const frameRect = window.get_frame_rect();
        const bufferRect = window.get_buffer_rect();

        finalY += frameRect.y - bufferRect.y;

        frameRect.y = finalY;

        this._focusTracker.disconnect(this._windowMovedId);
        window.move_frame(true, frameRect.x, frameRect.y);
        this._windowMovedId = this._focusTracker.connect('window-moved',
            this._onFocusWindowMoving.bind(this));
    }

    /**
     * @param {Meta.Window} window
     * @param {boolean} show
     */
    _animateWindow(window, show) {
        /** @type {Meta.WindowActor | null} */
        const windowActor = window.get_compositor_private();
        if (!windowActor)
            return;

        const finalY = show
            ? this._focusWindowStartY - Main.layoutManager.keyboardBox.height
            : this._focusWindowStartY;

        let unmanaged = false;
        const winUnmanagedId = window.connect('unmanaged', () => {
            unmanaged = true;
        });

        windowActor.ease({
            y: finalY,
            duration: KEYBOARD_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                window.disconnect(winUnmanagedId);

                if (unmanaged)
                    return;

                windowActor.y = finalY;
                this._windowSlideAnimationComplete(window, finalY);
            },
        });
    }

    _onFocusWindowMoving() {
        if (this._focusTracker.currentWindow === this._focusWindow) {
            // Don't use _setFocusWindow() here because that would move the
            // window while the user has grabbed it. Instead we simply "let go"
            // of the window.
            this._focusWindow = null;
            this._focusWindowStartY = null;
        }

        this.close(true);
    }

    /** @param {Meta.Window | null} window */
    _setFocusWindow(window) {
        if (this._focusWindow === window)
            return;

        if (this._keyboardVisible && this._focusWindow)
            this._animateWindow(this._focusWindow, false);

        /** @type {Meta.WindowActor | null} */
        const windowActor = window?.get_compositor_private();
        windowActor?.remove_transition('y');
        this._focusWindowStartY = windowActor ? windowActor.y : null;

        if (this._keyboardVisible && window)
            this._animateWindow(window, true);

        this._focusWindow = window;
    }

    /**
     * @param {Meta.Window | null} window
     * @param {number} [x]
     * @param {number} [y]
     * @param {number} [w]
     * @param {number} [h]
     */
    setCursorLocation(window, x, y, w, h) {
        const monitor = Main.layoutManager.keyboardMonitor;

        if (window && monitor) {
            const keyboardHeight = Main.layoutManager.keyboardBox.height;
            const keyboardY1 = (monitor.y + monitor.height) - keyboardHeight;

            if (this._focusWindow === window) {
                if (y + h + keyboardHeight < keyboardY1)
                    this._setFocusWindow(null);

                return;
            }

            if (y + h >= keyboardY1)
                this._setFocusWindow(window);
            else
                this._setFocusWindow(null);
        } else {
            this._setFocusWindow(null);
        }
    }
});

class KeyboardController extends Signals.EventEmitter {
    /** @type {boolean | undefined} */
    _oskCompletionEnabled;
    /** @type {boolean | undefined} */
    _deleteEnabled;
    constructor() {
        super();

        const seat = global.stage.context.get_backend().get_default_seat();
        this._virtualDevice = seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

        this._inputSourceManager = InputSourceManager.getInputSourceManager();
        this._inputSourceManager.connectObject(
            'current-source-changed', this._onSourceChanged.bind(this),
            'sources-changed', this._onSourcesModified.bind(this), this);
        this._currentSource = this._inputSourceManager.currentSource;
        this._purpose = Main.inputMethod.contentPurpose;

        Main.inputMethod.connectObject(
            'notify::content-purpose', this._onPurposeHintsChanged.bind(this),
            'notify::content-hints', this._onContentHintsChanged.bind(this),
            'input-panel-state',
            /**
             * @param {Clutter.InputMethod} o
             * @param {Clutter.InputPanelState} state
             */
            (o, state) => this.emit('panel-state', state), this);
    }

    get purpose() {
        return this._purpose;
    }

    destroy() {
        this._inputSourceManager.disconnectObject(this);
        Main.inputMethod.disconnectObject(this);

        // Make sure any buttons pressed by the virtual device are released
        // immediately instead of waiting for the next GC cycle
        this._virtualDevice.run_dispose();
    }

    _onSourcesModified() {
        this.emit('group-changed');
    }

    /**
     * @param {ReturnType<typeof InputSourceManager.getInputSourceManager>} inputSourceManager
     * @param {object} _oldSource
     */
    _onSourceChanged(inputSourceManager, _oldSource) {
        const source = inputSourceManager.currentSource;
        this._currentSource = source;
        this.emit('group-changed');
    }

    /** @param {NonNullable<typeof Main.inputMethod>} method */
    _onPurposeHintsChanged(method) {
        const purpose = method.content_purpose;
        this._purpose = purpose;
        this.emit('purpose-changed', purpose);
    }

    /** @param {NonNullable<typeof Main.inputMethod>} method */
    _onContentHintsChanged(method) {
        const contentHints = method.content_hints;
        this._contentHints = contentHints;
        this.emit('content-hints-changed', contentHints);
    }

    getCurrentGroup() {
        // Special case for Korean, if Hangul mode is disabled, use the 'us' keymap
        if (this._currentSource.id === 'hangul') {
            const inputSourceManager = InputSourceManager.getInputSourceManager();
            const currentSource = inputSourceManager.currentSource;
            let prop;
            for (let i = 0; (prop = currentSource.properties.get(i)) !== null; ++i) {
                if (prop.get_key() === 'InputMode' &&
                    prop.get_prop_type() === IBus.PropType.TOGGLE &&
                    prop.get_state() !== IBus.PropState.CHECKED)
                    return 'us';
            }
        }

        return this._currentSource.xkbId;
    }

    /**
     * @param {Set<number>} modifiers
     * @param {Clutter.EventType} type
     */
    _forwardModifiers(modifiers, type) {
        for (const keyval of modifiers) {
            if (type === Clutter.EventType.KEY_PRESS)
                this.keyvalPress(keyval);
            else if (type === Clutter.EventType.KEY_RELEASE)
                this.keyvalRelease(keyval);
        }
    }

    /** @param {string} string */
    _getKeyvalsFromString(string) {
        const keyvals = [];
        for (const unicode of string) {
            const keyval = Clutter.unicode_to_keysym(unicode.codePointAt(0));
            // If the unicode character is unknown, try to avoid keyvals at all
            if (keyval === (unicode || 0x01000000))
                return [];

            keyvals.push(keyval);
        }

        return keyvals;
    }

    /**
     * @param {string} str
     * @param {Set<number>} [modifiers]
     */
    async commit(str, modifiers) {
        const keyvals = this._getKeyvalsFromString(str);

        // If there is no IM focus (e.g. with X11 clients), or modifiers
        // are in use, send raw key events.
        if (!Main.inputMethod.currentFocus || modifiers?.size > 0) {
            if (modifiers)
                this._forwardModifiers(modifiers, Clutter.EventType.KEY_PRESS);

            for (const keyval of keyvals) {
                this.keyvalPress(keyval);
                this.keyvalRelease(keyval);
            }

            if (modifiers)
                this._forwardModifiers(modifiers, Clutter.EventType.KEY_RELEASE);

            return;
        }

        // If OSK completion is enabled, or there is an active source requiring
        // IBus to receive input, prefer to feed the events directly to the IM
        if (this._oskCompletionEnabled ||
            this._currentSource.type === InputSourceManager.INPUT_SOURCE_TYPE_IBUS) {
            for (const keyval of keyvals) {
                // eslint-disable-next-line no-await-in-loop
                if (!await Main.inputMethod.handleVirtualKey(keyval)) {
                    this.keyvalPress(keyval);
                    this.keyvalRelease(keyval);
                }
            }
            return;
        }

        Main.inputMethod.commit(str);
    }

    /** @param {boolean} enabled */
    async setOskCompletion(enabled) {
        if (this._oskCompletionEnabled === enabled)
            return;

        this._oskCompletionEnabled =
            await IBusManager.getIBusManager().setCompletionEnabled(enabled);

        Main.inputMethod.update();
    }

    /** @param {number} keyval */
    keyvalPress(keyval) {
        this._virtualDevice.notify_keyval(Clutter.get_current_event_time() * 1000,
            keyval, Clutter.KeyState.PRESSED);
    }

    /** @param {number} keyval */
    keyvalRelease(keyval) {
        this._virtualDevice.notify_keyval(Clutter.get_current_event_time() * 1000,
            keyval, Clutter.KeyState.RELEASED);
    }

    /**
     * @param {string} text
     * @param {number} cursor
     */
    _previousWordPosition(text, cursor) {
        const upToCursor = [...text].slice(0, cursor).join('');
        const jsStringPos = Math.max(0, upToCursor.search(/\s+\S+\s*$/));
        const charPos = GLib.utf8_strlen(text.slice(0, jsStringPos), -1);
        return charPos;
    }

    /** @param {boolean} enabled */
    toggleDelete(enabled) {
        if (this._deleteEnabled === enabled)
            return;

        this._deleteEnabled = enabled;
        this._timesDeleted = 0;

        /* If there is no IM focus or are in the middle of preedit, fallback to
         * keypresses */
        if (enabled &&
            (!Main.inputMethod.currentFocus ||
             Main.inputMethod.hasPreedit() ||
             this._purpose === Clutter.InputContentPurpose.TERMINAL)) {
            this.keyvalPress(Clutter.KEY_BackSpace);
            this._backspacePressed = true;
            return;
        }

        if (!enabled && this._backspacePressed) {
            this.keyvalRelease(Clutter.KEY_BackSpace);
            delete this._backspacePressed;
            return;
        }

        if (enabled) {
            /**
             * @param {string} text
             * @param {number} cursor
             * @param {number} anchor
             */
            const func = (text, cursor, anchor) => {
                if (cursor === 0 && anchor === 0)
                    return;

                let offset, len;
                if (cursor > anchor) {
                    offset = anchor - cursor;
                    len = -offset;
                } else if (cursor < anchor) {
                    offset = 0;
                    len = anchor - cursor;
                } else if (this._timesDeleted < BACKSPACE_WORD_DELETE_THRESHOLD) {
                    offset = -1;
                    len = 1;
                } else {
                    const wordLength = cursor - this._previousWordPosition(text, cursor);
                    offset = -wordLength;
                    len = wordLength;
                }

                this._timesDeleted++;
                Main.inputMethod.delete_surrounding(offset, len);
            };

            this._surroundingUpdateId = Main.inputMethod.connect(
                'surrounding-text-set', () => {
                    const [text, cursor, anchor] = Main.inputMethod.getSurroundingText();
                    if (this._timesDeleted === 0) {
                        func(text, cursor, anchor);
                    } else {
                        if (this._surroundingUpdateTimeoutId > 0) {
                            GLib.source_remove(this._surroundingUpdateTimeoutId);
                            this._surroundingUpdateTimeoutId = 0;
                        }
                        this._surroundingUpdateTimeoutId =
                            GLib.timeout_add_once(GLib.PRIORITY_DEFAULT, KEY_RELEASE_TIMEOUT, () => {
                                func(text, cursor, cursor);
                                this._surroundingUpdateTimeoutId = 0;
                            });
                    }
                });

            const [text, cursor, anchor] = Main.inputMethod.getSurroundingText();
            if (text)
                func(text, cursor, anchor);
            else
                Main.inputMethod.request_surrounding();
        } else {
            if (this._surroundingUpdateId > 0) {
                Main.inputMethod.disconnect(this._surroundingUpdateId);
                this._surroundingUpdateId = 0;
            }
            if (this._surroundingUpdateTimeoutId > 0) {
                GLib.source_remove(this._surroundingUpdateTimeoutId);
                this._surroundingUpdateTimeoutId = 0;
            }
        }
    }
}
