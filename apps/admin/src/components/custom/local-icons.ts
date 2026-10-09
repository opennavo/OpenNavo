import type { Component } from 'vue';
import Activity from '~icons/local/activity';
import AtSign from '~icons/local/at-sign';
import Avatar from '~icons/local/avatar';
import Banner from '~icons/local/banner';
import Cast from '~icons/local/cast';
import Chrome from '~icons/local/chrome';
import Copy from '~icons/local/copy';
import CustomIcon from '~icons/local/custom-icon';
import EmptyData from '~icons/local/empty-data';
import Expectation from '~icons/local/expectation';
import Heart from '~icons/local/heart';
import Logo from '~icons/local/logo';
import NetworkError from '~icons/local/network-error';
import NoIcon from '~icons/local/no-icon';
import NoPermission from '~icons/local/no-permission';
import NotFound from '~icons/local/not-found';
import ServiceError from '~icons/local/service-error';
import Wind from '~icons/local/wind';

// Compile trusted repository SVGs through the existing unplugin-icons pipeline.
export const localIcons: Record<string, Component> = {
  activity: Activity,
  'at-sign': AtSign,
  avatar: Avatar,
  banner: Banner,
  cast: Cast,
  chrome: Chrome,
  copy: Copy,
  'custom-icon': CustomIcon,
  'empty-data': EmptyData,
  expectation: Expectation,
  heart: Heart,
  logo: Logo,
  'network-error': NetworkError,
  'no-icon': NoIcon,
  'no-permission': NoPermission,
  'not-found': NotFound,
  'service-error': ServiceError,
  wind: Wind
};
