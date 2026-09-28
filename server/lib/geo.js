'use strict';
/*
 * Where things go on the Overview's world map.
 *
 * One projection, used both to draw the land (scripts/make-worldmap.js) and to place each region's marker
 * (the API returns the position), so a marker can never drift off the outline it belongs to.
 *
 * It is the Miller cylindrical projection: like Mercator, but with the poles pulled in so Greenland and
 * Russia are not absurd. The map runs the whole world east to west and from 58 S to 84 N, which leaves
 * out Antarctica and the polar cap and keeps the aspect ratio near 2:1.
 */

const LON_MIN = -180;
const LON_MAX = 180;
const LAT_MIN = -58;
const LAT_MAX = 84;

const rad = (d) => (d * Math.PI) / 180;
// Miller: y = 1.25 ln tan(pi/4 + 0.4 phi)
const millerY = (latDeg) => 1.25 * Math.log(Math.tan(Math.PI / 4 + 0.4 * rad(latDeg)));

const Y_TOP = millerY(LAT_MAX);
const Y_BOTTOM = millerY(LAT_MIN);
const WIDTH = 1000;
const HEIGHT = Math.round((WIDTH * (Y_TOP - Y_BOTTOM)) / (rad(LON_MAX) - rad(LON_MIN)));

/**
 * @returns {{x:number, y:number}} position as a share of the map, from the top left: 0 to 1 each way.
 *   A place outside the map's latitudes is pinned to its edge rather than dropped off it.
 */
function project(lat, lon) {
  const clampedLat = Math.max(LAT_MIN, Math.min(LAT_MAX, lat));
  const x = (lon - LON_MIN) / (LON_MAX - LON_MIN);
  const y = (Y_TOP - millerY(clampedLat)) / (Y_TOP - Y_BOTTOM);
  return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
}

/** The same position in the map's own drawing units (a WIDTH x HEIGHT box). */
const toDrawing = (lat, lon) => { const p = project(lat, lon); return { x: p.x * WIDTH, y: p.y * HEIGHT }; };

module.exports = { project, toDrawing, millerY, WIDTH, HEIGHT, LON_MIN, LON_MAX, LAT_MIN, LAT_MAX };
