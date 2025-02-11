/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 * @flow
 */

'use strict';

const React = require('react');
const Dimensions = require('../Utilities/Dimensions');
const FrameRateLogger = require('../Interaction/FrameRateLogger');
const Keyboard = require('./Keyboard/Keyboard');
const ReactNative = require('../Renderer/shims/ReactNative');
const TextInputState = require('./TextInput/TextInputState');
const UIManager = require('../ReactNative/UIManager');
const Platform = require('../Utilities/Platform');
const ScrollView = require('./ScrollView/ScrollView');

const invariant = require('invariant');
const nullthrows = require('nullthrows');
const performanceNow = require('fbjs/lib/performanceNow');

import type {PressEvent, ScrollEvent} from '../Types/CoreEventTypes';
import type {Props as ScrollViewProps} from './ScrollView/ScrollView';
import type {KeyboardEvent} from './Keyboard/Keyboard';
import type EmitterSubscription from '../vendor/emitter/EmitterSubscription';

/**
 * Mixin that can be integrated in order to handle scrolling that plays well
 * with `ResponderEventPlugin`. Integrate with your platform specific scroll
 * views, or even your custom built (every-frame animating) scroll views so that
 * all of these systems play well with the `ResponderEventPlugin`.
 *
 * iOS scroll event timing nuances:
 * ===============================
 *
 *
 * Scrolling without bouncing, if you touch down:
 * -------------------------------
 *
 * 1. `onMomentumScrollBegin` (when animation begins after letting up)
 *    ... physical touch starts ...
 * 2. `onTouchStartCapture`   (when you press down to stop the scroll)
 * 3. `onTouchStart`          (same, but bubble phase)
 * 4. `onResponderRelease`    (when lifting up - you could pause forever before * lifting)
 * 5. `onMomentumScrollEnd`
 *
 *
 * Scrolling with bouncing, if you touch down:
 * -------------------------------
 *
 * 1. `onMomentumScrollBegin` (when animation begins after letting up)
 *    ... bounce begins ...
 *    ... some time elapses ...
 *    ... physical touch during bounce ...
 * 2. `onMomentumScrollEnd`   (Makes no sense why this occurs first during bounce)
 * 3. `onTouchStartCapture`   (immediately after `onMomentumScrollEnd`)
 * 4. `onTouchStart`          (same, but bubble phase)
 * 5. `onTouchEnd`            (You could hold the touch start for a long time)
 * 6. `onMomentumScrollBegin` (When releasing the view starts bouncing back)
 *
 * So when we receive an `onTouchStart`, how can we tell if we are touching
 * *during* an animation (which then causes the animation to stop)? The only way
 * to tell is if the `touchStart` occurred immediately after the
 * `onMomentumScrollEnd`.
 *
 * This is abstracted out for you, so you can just call this.scrollResponderIsAnimating() if
 * necessary
 *
 * `ScrollResponder` also includes logic for blurring a currently focused input
 * if one is focused while scrolling. The `ScrollResponder` is a natural place
 * to put this logic since it can support not dismissing the keyboard while
 * scrolling, unless a recognized "tap"-like gesture has occurred.
 *
 * The public lifecycle API includes events for keyboard interaction, responder
 * interaction, and scrolling (among others). The keyboard callbacks
 * `onKeyboardWill/Did/*` are *global* events, but are invoked on scroll
 * responder's props so that you can guarantee that the scroll responder's
 * internal state has been updated accordingly (and deterministically) by
 * the time the props callbacks are invoke. Otherwise, you would always wonder
 * if the scroll responder is currently in a state where it recognizes new
 * keyboard positions etc. If coordinating scrolling with keyboard movement,
 * *always* use these hooks instead of listening to your own global keyboard
 * events.
 *
 * Public keyboard lifecycle API: (props callbacks)
 *
 * Standard Keyboard Appearance Sequence:
 *
 *   this.props.onKeyboardWillShow
 *   this.props.onKeyboardDidShow
 *
 * `onScrollResponderKeyboardDismissed` will be invoked if an appropriate
 * tap inside the scroll responder's scrollable region was responsible
 * for the dismissal of the keyboard. There are other reasons why the
 * keyboard could be dismissed.
 *
 *   this.props.onScrollResponderKeyboardDismissed
 *
 * Standard Keyboard Hide Sequence:
 *
 *   this.props.onKeyboardWillHide
 *   this.props.onKeyboardDidHide
 */

const IS_ANIMATING_TOUCH_START_THRESHOLD_MS = 16;

export type State = {|
  isTouching: boolean,
  lastMomentumScrollBeginTime: number,
  lastMomentumScrollEndTime: number,
  observedScrollSinceBecomingResponder: boolean,
  becameResponderWhileAnimating: boolean,
|};

const ScrollResponderMixin = {
  _subscriptionKeyboardWillShow: (null: ?EmitterSubscription),
  _subscriptionKeyboardWillHide: (null: ?EmitterSubscription),
  _subscriptionKeyboardDidShow: (null: ?EmitterSubscription),
  _subscriptionKeyboardDidHide: (null: ?EmitterSubscription),
  scrollResponderMixinGetInitialState: function(): State {
    return {
      isTouching: false,
      lastMomentumScrollBeginTime: 0,
      lastMomentumScrollEndTime: 0,

      // Reset to false every time becomes responder. This is used to:
      // - Determine if the scroll view has been scrolled and therefore should
      // refuse to give up its responder lock.
      // - Determine if releasing should dismiss the keyboard when we are in
      // tap-to-dismiss mode (this.props.keyboardShouldPersistTaps !== 'always').
      observedScrollSinceBecomingResponder: false,
      becameResponderWhileAnimating: false,
    };
  },

  /**
   * Invoke this from an `onScroll` event.
   */
  scrollResponderHandleScrollShouldSetResponder: function(): boolean {
    // Allow any event touch pass through if the default pan responder is disabled
    if (this.props.disableScrollViewPanResponder === true) {
      return false;
    }
    return this.state.isTouching;
  },

  /**
   * Merely touch starting is not sufficient for a scroll view to become the
   * responder. Being the "responder" means that the very next touch move/end
   * event will result in an action/movement.
   *
   * Invoke this from an `onStartShouldSetResponder` event.
   *
   * `onStartShouldSetResponder` is used when the next move/end will trigger
   * some UI movement/action, but when you want to yield priority to views
   * nested inside of the view.
   *
   * There may be some cases where scroll views actually should return `true`
   * from `onStartShouldSetResponder`: Any time we are detecting a standard tap
   * that gives priority to nested views.
   *
   * - If a single tap on the scroll view triggers an action such as
   *   recentering a map style view yet wants to give priority to interaction
   *   views inside (such as dropped pins or labels), then we would return true
   *   from this method when there is a single touch.
   *
   * - Similar to the previous case, if a two finger "tap" should trigger a
   *   zoom, we would check the `touches` count, and if `>= 2`, we would return
   *   true.
   *
   */
  scrollResponderHandleStartShouldSetResponder: function(
    e: PressEvent,
  ): boolean {
    // Allow any event touch pass through if the default pan responder is disabled
    if (this.props.disableScrollViewPanResponder === true) {
      return false;
    }

    const currentlyFocusedTextInput = TextInputState.currentlyFocusedField();

    if (
      this.props.keyboardShouldPersistTaps === 'handled' &&
      currentlyFocusedTextInput != null &&
      e.target !== currentlyFocusedTextInput
    ) {
      return true;
    }
    return false;
  },

  /**
   * There are times when the scroll view wants to become the responder
   * (meaning respond to the next immediate `touchStart/touchEnd`), in a way
   * that *doesn't* give priority to nested views (hence the capture phase):
   *
   * - Currently animating.
   * - Tapping anywhere that is not a text input, while the keyboard is
   *   up (which should dismiss the keyboard).
   *
   * Invoke this from an `onStartShouldSetResponderCapture` event.
   */
  scrollResponderHandleStartShouldSetResponderCapture: function(
    e: PressEvent,
  ): boolean {
    // The scroll view should receive taps instead of its descendants if:
    // * it is already animating/decelerating
    if (this.scrollResponderIsAnimating()) {
      return true;
    }

    // Allow any event touch pass through if the default pan responder is disabled
    if (this.props.disableScrollViewPanResponder === true) {
      return false;
    }

    // * the keyboard is up, keyboardShouldPersistTaps is 'never' (the default),
    // and a new touch starts with a non-textinput target (in which case the
    // first tap should be sent to the scroll view and dismiss the keyboard,
    // then the second tap goes to the actual interior view)
    const currentlyFocusedTextInput = TextInputState.currentlyFocusedField();
    const {keyboardShouldPersistTaps} = this.props;
    const keyboardNeverPersistTaps =
      !keyboardShouldPersistTaps || keyboardShouldPersistTaps === 'never';
    if (
      keyboardNeverPersistTaps &&
      currentlyFocusedTextInput != null &&
      e.target &&
      !TextInputState.isTextInput(e.target)
    ) {
      return true;
    }

    return false;
  },

  /**
   * Invoke this from an `onResponderReject` event.
   *
   * Some other element is not yielding its role as responder. Normally, we'd
   * just disable the `UIScrollView`, but a touch has already began on it, the
   * `UIScrollView` will not accept being disabled after that. The easiest
   * solution for now is to accept the limitation of disallowing this
   * altogether. To improve this, find a way to disable the `UIScrollView` after
   * a touch has already started.
   */
  scrollResponderHandleResponderReject: function() {},

  /**
   * We will allow the scroll view to give up its lock iff it acquired the lock
   * during an animation. This is a very useful default that happens to satisfy
   * many common user experiences.
   *
   * - Stop a scroll on the left edge, then turn that into an outer view's
   *   backswipe.
   * - Stop a scroll mid-bounce at the top, continue pulling to have the outer
   *   view dismiss.
   * - However, without catching the scroll view mid-bounce (while it is
   *   motionless), if you drag far enough for the scroll view to become
   *   responder (and therefore drag the scroll view a bit), any backswipe
   *   navigation of a swipe gesture higher in the view hierarchy, should be
   *   rejected.
   */
  scrollResponderHandleTerminationRequest: function(): boolean {
    return !this.state.observedScrollSinceBecomingResponder;
  },

  /**
   * Invoke this from an `onTouchEnd` event.
   *
   * @param {PressEvent} e Event.
   */
  scrollResponderHandleTouchEnd: function(e: PressEvent) {
    const nativeEvent = e.nativeEvent;
    this.state.isTouching = nativeEvent.touches.length !== 0;
    this.props.onTouchEnd && this.props.onTouchEnd(e);
  },

  /**
   * Invoke this from an `onTouchCancel` event.
   *
   * @param {PressEvent} e Event.
   */
  scrollResponderHandleTouchCancel: function(e: PressEvent) {
    this.state.isTouching = false;
    this.props.onTouchCancel && this.props.onTouchCancel(e);
  },

  /**
   * Invoke this from an `onResponderRelease` event.
   */
  scrollResponderHandleResponderRelease: function(e: PressEvent) {
    this.props.onResponderRelease && this.props.onResponderRelease(e);

    // By default scroll views will unfocus a textField
    // if another touch occurs outside of it
    const currentlyFocusedTextInput = TextInputState.currentlyFocusedField();
    if (
      this.props.keyboardShouldPersistTaps !== true &&
      this.props.keyboardShouldPersistTaps !== 'always' &&
      currentlyFocusedTextInput != null &&
      e.target !== currentlyFocusedTextInput &&
      !this.state.observedScrollSinceBecomingResponder &&
      !this.state.becameResponderWhileAnimating
    ) {
      this.props.onScrollResponderKeyboardDismissed &&
        this.props.onScrollResponderKeyboardDismissed(e);
      TextInputState.blurTextInput(currentlyFocusedTextInput);
    }
  },

  scrollResponderHandleScroll: function(e: ScrollEvent) {
    (this: any).state.observedScrollSinceBecomingResponder = true;
    (this: any).props.onScroll && (this: any).props.onScroll(e);
  },

  /**
   * Invoke this from an `onResponderGrant` event.
   */
  scrollResponderHandleResponderGrant: function(e: ScrollEvent) {
    this.state.observedScrollSinceBecomingResponder = false;
    this.props.onResponderGrant && this.props.onResponderGrant(e);
    this.state.becameResponderWhileAnimating = this.scrollResponderIsAnimating();
  },

  /**
   * Unfortunately, `onScrollBeginDrag` also fires when *stopping* the scroll
   * animation, and there's not an easy way to distinguish a drag vs. stopping
   * momentum.
   *
   * Invoke this from an `onScrollBeginDrag` event.
   */
  scrollResponderHandleScrollBeginDrag: function(e: ScrollEvent) {
    FrameRateLogger.beginScroll(); // TODO: track all scrolls after implementing onScrollEndAnimation
    this.props.onScrollBeginDrag && this.props.onScrollBeginDrag(e);
  },

  /**
   * Invoke this from an `onScrollEndDrag` event.
   */
  scrollResponderHandleScrollEndDrag: function(e: ScrollEvent) {
    const {velocity} = e.nativeEvent;
    // - If we are animating, then this is a "drag" that is stopping the scrollview and momentum end
    //   will fire.
    // - If velocity is non-zero, then the interaction will stop when momentum scroll ends or
    //   another drag starts and ends.
    // - If we don't get velocity, better to stop the interaction twice than not stop it.
    if (
      !this.scrollResponderIsAnimating() &&
      (!velocity || (velocity.x === 0 && velocity.y === 0))
    ) {
      FrameRateLogger.endScroll();
    }
    this.props.onScrollEndDrag && this.props.onScrollEndDrag(e);
  },

  /**
   * Invoke this from an `onMomentumScrollBegin` event.
   */
  scrollResponderHandleMomentumScrollBegin: function(e: ScrollEvent) {
    this.state.lastMomentumScrollBeginTime = performanceNow();
    this.props.onMomentumScrollBegin && this.props.onMomentumScrollBegin(e);
  },

  /**
   * Invoke this from an `onMomentumScrollEnd` event.
   */
  scrollResponderHandleMomentumScrollEnd: function(e: ScrollEvent) {
    FrameRateLogger.endScroll();
    this.state.lastMomentumScrollEndTime = performanceNow();
    this.props.onMomentumScrollEnd && this.props.onMomentumScrollEnd(e);
  },

  /**
   * Invoke this from an `onTouchStart` event.
   *
   * Since we know that the `SimpleEventPlugin` occurs later in the plugin
   * order, after `ResponderEventPlugin`, we can detect that we were *not*
   * permitted to be the responder (presumably because a contained view became
   * responder). The `onResponderReject` won't fire in that case - it only
   * fires when a *current* responder rejects our request.
   *
   * @param {PressEvent} e Touch Start event.
   */
  scrollResponderHandleTouchStart: function(e: PressEvent) {
    this.state.isTouching = true;
    this.props.onTouchStart && this.props.onTouchStart(e);
  },

  /**
   * Invoke this from an `onTouchMove` event.
   *
   * Since we know that the `SimpleEventPlugin` occurs later in the plugin
   * order, after `ResponderEventPlugin`, we can detect that we were *not*
   * permitted to be the responder (presumably because a contained view became
   * responder). The `onResponderReject` won't fire in that case - it only
   * fires when a *current* responder rejects our request.
   *
   * @param {PressEvent} e Touch Start event.
   */
  scrollResponderHandleTouchMove: function(e: PressEvent) {
    this.props.onTouchMove && this.props.onTouchMove(e);
  },

  /**
   * A helper function for this class that lets us quickly determine if the
   * view is currently animating. This is particularly useful to know when
   * a touch has just started or ended.
   */
  scrollResponderIsAnimating: function(): boolean {
    const now = performanceNow();
    const timeSinceLastMomentumScrollEnd =
      now - this.state.lastMomentumScrollEndTime;
    const isAnimating =
      timeSinceLastMomentumScrollEnd < IS_ANIMATING_TOUCH_START_THRESHOLD_MS ||
      this.state.lastMomentumScrollEndTime <
        this.state.lastMomentumScrollBeginTime;
    return isAnimating;
  },

  /**
   * Returns the node that represents native view that can be scrolled.
   * Components can pass what node to use by defining a `getScrollableNode`
   * function otherwise `this` is used.
   */
  scrollResponderGetScrollableNode: function(): ?number {
    return this.getScrollableNode
      ? this.getScrollableNode()
      : ReactNative.findNodeHandle(this);
  },

  /**
   * A helper function to scroll to a specific point in the ScrollView.
   * This is currently used to help focus child TextViews, but can also
   * be used to quickly scroll to any element we want to focus. Syntax:
   *
   * `scrollResponderScrollTo(options: {x: number = 0; y: number = 0; animated: boolean = true})`
   *
   * Note: The weird argument signature is due to the fact that, for historical reasons,
   * the function also accepts separate arguments as as alternative to the options object.
   * This is deprecated due to ambiguity (y before x), and SHOULD NOT BE USED.
   */
  scrollResponderScrollTo: function(
    x?: number | {x?: number, y?: number, animated?: boolean},
    y?: number,
    animated?: boolean,
  ) {
    if (typeof x === 'number') {
      console.warn(
        '`scrollResponderScrollTo(x, y, animated)` is deprecated. Use `scrollResponderScrollTo({x: 5, y: 5, animated: true})` instead.',
      );
    } else {
      ({x, y, animated} = x || {});
    }
    UIManager.dispatchViewManagerCommand(
      nullthrows(this.scrollResponderGetScrollableNode()),
      UIManager.getViewManagerConfig('RCTScrollView').Commands.scrollTo,
      [x || 0, y || 0, animated !== false],
    );
  },

  /**
   * Scrolls to the end of the ScrollView, either immediately or with a smooth
   * animation.
   *
   * Example:
   *
   * `scrollResponderScrollToEnd({animated: true})`
   */
  scrollResponderScrollToEnd: function(options?: {animated?: boolean}) {
    // Default to true
    const animated = (options && options.animated) !== false;
    UIManager.dispatchViewManagerCommand(
      this.scrollResponderGetScrollableNode(),
      UIManager.getViewManagerConfig('RCTScrollView').Commands.scrollToEnd,
      [animated],
    );
  },

  /**
   * A helper function to zoom to a specific rect in the scrollview. The argument has the shape
   * {x: number; y: number; width: number; height: number; animated: boolean = true}
   *
   * @platform ios
   */
  scrollResponderZoomTo: function(
    rect: {|
      x: number,
      y: number,
      width: number,
      height: number,
      animated?: boolean,
    |},
    animated?: boolean, // deprecated, put this inside the rect argument instead
  ) {
    invariant(Platform.OS === 'ios', 'zoomToRect is not implemented');
    if ('animated' in rect) {
      animated = rect.animated;
      delete rect.animated;
    } else if (typeof animated !== 'undefined') {
      console.warn(
        '`scrollResponderZoomTo` `animated` argument is deprecated. Use `options.animated` instead',
      );
    }
    invariant(
      this.getNativeScrollRef != null,
      'Expected zoomToRect to be called on a scrollViewRef. If this exception occurs it is likely a bug in React Native',
    );
    ScrollView.Commands.zoomToRect(
      this.getNativeScrollRef(),
      rect,
      animated !== false,
    );
  },

  /**
   * Displays the scroll indicators momentarily.
   */
  scrollResponderFlashScrollIndicators: function() {
    UIManager.dispatchViewManagerCommand(
      this.scrollResponderGetScrollableNode(),
      UIManager.getViewManagerConfig('RCTScrollView').Commands
        .flashScrollIndicators,
      [],
    );
  },

  /**
   * This method should be used as the callback to onFocus in a TextInputs'
   * parent view. Note that any module using this mixin needs to return
   * the parent view's ref in getScrollViewRef() in order to use this method.
   * @param {number} nodeHandle The TextInput node handle
   * @param {number} additionalOffset The scroll view's bottom "contentInset".
   *        Default is 0.
   * @param {bool} preventNegativeScrolling Whether to allow pulling the content
   *        down to make it meet the keyboard's top. Default is false.
   */
  scrollResponderScrollNativeHandleToKeyboard: function<T>(
    nodeHandle:
      | number
      | React.ElementRef<Class<ReactNative.NativeComponent<T>>>,
    additionalOffset?: number,
    preventNegativeScrollOffset?: boolean,
  ) {
    this.additionalScrollOffset = additionalOffset || 0;
    this.preventNegativeScrollOffset = !!preventNegativeScrollOffset;

    if (typeof nodeHandle === 'number') {
      UIManager.measureLayout(
        nodeHandle,
        ReactNative.findNodeHandle(this.getInnerViewNode()),
        this.scrollResponderTextInputFocusError,
        this.scrollResponderInputMeasureAndScrollToKeyboard,
      );
    } else {
      nodeHandle.measureLayout(
        this.getInnerViewRef(),
        this.scrollResponderInputMeasureAndScrollToKeyboard,
        this.scrollResponderTextInputFocusError,
      );
    }
  },

  /**
   * The calculations performed here assume the scroll view takes up the entire
   * screen - even if has some content inset. We then measure the offsets of the
   * keyboard, and compensate both for the scroll view's "contentInset".
   *
   * @param {number} left Position of input w.r.t. table view.
   * @param {number} top Position of input w.r.t. table view.
   * @param {number} width Width of the text input.
   * @param {number} height Height of the text input.
   */
  scrollResponderInputMeasureAndScrollToKeyboard: function(
    left: number,
    top: number,
    width: number,
    height: number,
  ) {
    let keyboardScreenY = Dimensions.get('window').height;
    if (this.keyboardWillOpenTo) {
      keyboardScreenY = this.keyboardWillOpenTo.endCoordinates.screenY;
    }
    let scrollOffsetY =
      top - keyboardScreenY + height + this.additionalScrollOffset;

    // By default, this can scroll with negative offset, pulling the content
    // down so that the target component's bottom meets the keyboard's top.
    // If requested otherwise, cap the offset at 0 minimum to avoid content
    // shifting down.
    if (this.preventNegativeScrollOffset) {
      scrollOffsetY = Math.max(0, scrollOffsetY);
    }
    this.scrollResponderScrollTo({x: 0, y: scrollOffsetY, animated: true});

    this.additionalOffset = 0;
    this.preventNegativeScrollOffset = false;
  },

  scrollResponderTextInputFocusError: function(msg: string) {
    console.error('Error measuring text field: ', msg);
  },

  /**
   * `componentWillMount` is the closest thing to a  standard "constructor" for
   * React components.
   *
   * The `keyboardWillShow` is called before input focus.
   */
  UNSAFE_componentWillMount: function() {
    const {keyboardShouldPersistTaps} = ((this: any).props: ScrollViewProps);
    if (typeof keyboardShouldPersistTaps === 'boolean') {
      console.warn(
        `'keyboardShouldPersistTaps={${
          keyboardShouldPersistTaps === true ? 'true' : 'false'
        }}' is deprecated. ` +
          `Use 'keyboardShouldPersistTaps="${
            keyboardShouldPersistTaps ? 'always' : 'never'
          }"' instead`,
      );
    }

    (this: any).keyboardWillOpenTo = null;
    (this: any).additionalScrollOffset = 0;
    this._subscriptionKeyboardWillShow = Keyboard.addListener(
      'keyboardWillShow',
      this.scrollResponderKeyboardWillShow,
    );

    this._subscriptionKeyboardWillHide = Keyboard.addListener(
      'keyboardWillHide',
      this.scrollResponderKeyboardWillHide,
    );
    this._subscriptionKeyboardDidShow = Keyboard.addListener(
      'keyboardDidShow',
      this.scrollResponderKeyboardDidShow,
    );
    this._subscriptionKeyboardDidHide = Keyboard.addListener(
      'keyboardDidHide',
      this.scrollResponderKeyboardDidHide,
    );
  },

  componentWillUnmount: function() {
    if (this._subscriptionKeyboardWillShow != null) {
      this._subscriptionKeyboardWillShow.remove();
    }
    if (this._subscriptionKeyboardWillHide != null) {
      this._subscriptionKeyboardWillHide.remove();
    }
    if (this._subscriptionKeyboardDidShow != null) {
      this._subscriptionKeyboardDidShow.remove();
    }
    if (this._subscriptionKeyboardDidHide != null) {
      this._subscriptionKeyboardDidHide.remove();
    }
  },

  /**
   * Warning, this may be called several times for a single keyboard opening.
   * It's best to store the information in this method and then take any action
   * at a later point (either in `keyboardDidShow` or other).
   *
   * Here's the order that events occur in:
   * - focus
   * - willShow {startCoordinates, endCoordinates} several times
   * - didShow several times
   * - blur
   * - willHide {startCoordinates, endCoordinates} several times
   * - didHide several times
   *
   * The `ScrollResponder` module callbacks for each of these events.
   * Even though any user could have easily listened to keyboard events
   * themselves, using these `props` callbacks ensures that ordering of events
   * is consistent - and not dependent on the order that the keyboard events are
   * subscribed to. This matters when telling the scroll view to scroll to where
   * the keyboard is headed - the scroll responder better have been notified of
   * the keyboard destination before being instructed to scroll to where the
   * keyboard will be. Stick to the `ScrollResponder` callbacks, and everything
   * will work.
   *
   * WARNING: These callbacks will fire even if a keyboard is displayed in a
   * different navigation pane. Filter out the events to determine if they are
   * relevant to you. (For example, only if you receive these callbacks after
   * you had explicitly focused a node etc).
   */
  scrollResponderKeyboardWillShow: function(e: KeyboardEvent) {
    this.keyboardWillOpenTo = e;
    this.props.onKeyboardWillShow && this.props.onKeyboardWillShow(e);
  },

  scrollResponderKeyboardWillHide: function(e: KeyboardEvent) {
    this.keyboardWillOpenTo = null;
    this.props.onKeyboardWillHide && this.props.onKeyboardWillHide(e);
  },

  scrollResponderKeyboardDidShow: function(e: KeyboardEvent) {
    // TODO(7693961): The event for DidShow is not available on iOS yet.
    // Use the one from WillShow and do not assign.
    if (e) {
      this.keyboardWillOpenTo = e;
    }
    this.props.onKeyboardDidShow && this.props.onKeyboardDidShow(e);
  },

  scrollResponderKeyboardDidHide: function(e: KeyboardEvent) {
    this.keyboardWillOpenTo = null;
    this.props.onKeyboardDidHide && this.props.onKeyboardDidHide(e);
  },
};

const ScrollResponder = {
  Mixin: ScrollResponderMixin,
};

module.exports = ScrollResponder;
