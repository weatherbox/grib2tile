/*
 * @class L.equrectangularTile
 * @inherits TileLayer
 * @author Yuta Tachibana
 *
 * for leaflet v1.0.0-rc1
 *
 * fit equirectangular projection tiles to web mercator (spherical mercator)
 *
 */

L.EquirectangularTile = L.TileLayer.extend({


	options: {
		bounds: new L.latLngBounds([20.0, 118.0], [48.0, 150.0]),
		tileZoom: [1, 2, 3],
		tileSize: new L.Point(420, 320),
		opacity: 0.7
	},

	initialize: function (url, options) {

		this._url = url;
		options = L.setOptions(this, options);

		// tile bounds lat / lon
		this._tileBoundsLat = options.bounds.getNorth() - options.bounds.getSouth();
		this._tileBoundsLon = options.bounds.getEast() - options.bounds.getWest();

		// fix image-rendering does not work with css 3d
		if (L.Browser.chrome || (L.Browser.safari && !L.Browser.mobile)) {
			this._disable3DImageRendering = true;
			L.Browser.ie3d = true; // hack: use tranaslate
		}

		// for https://github.com/Leaflet/Leaflet/issues/137
		if (!L.Browser.android) {
			this.on('tileunload', this._onTileRemove);
		}
	},

	getTileUrl: function (coords) {
		return L.Util.template(this._url, {
			x: coords.ix,
			y: coords.iy,
			z: coords.iz	
		});
	},


	/* 
	 * override GridLayer Methods
	 *
	 * _tileCoordsToBounds, _keyToBounds, _globalTileRange are invalid in this class
	 *
	 */

	// calculate tileZoom from comparing lat/pixel
	_getTileZoom: function (mapZoom) {
		var sLatPx = 2 * L.Projection.SphericalMercator.MAX_LATITUDE / 256;
		var eLatPx = this._tileBoundsLat / this.options.tileSize.x;
		var scale = mapZoom + Math.log(eLatPx / sLatPx) / Math.log(2);

		return Math.max(0, Math.ceil(scale));
	},

	_getTileImageZoom: function (tileZoom) {
		for (var z in this.options.tileZoom) {
			var tileImageZoom = this.options.tileZoom[z];
		
			if (tileImageZoom >= tileZoom) {
				return tileImageZoom;
			}
		}
		return tileImageZoom;
	},


	// map latlonbounds -> coords bounds
	_getTileRange: function (mapBounds, tileZoom) {
		var tileBounds = this.options.bounds,
			tileOrigin = tileBounds.getNorthWest();

		var tileLat = this._tileBoundsLat / Math.pow(2, tileZoom),
			tileLon = this._tileBoundsLon / Math.pow(2, tileZoom);

		var N = Math.floor((tileOrigin.lat - mapBounds.getNorth()) / tileLat),
			W = Math.floor((mapBounds.getWest() - tileOrigin.lng) / tileLon),
			S = Math.floor((tileOrigin.lat - mapBounds.getSouth()) / tileLat),
			E = Math.floor((mapBounds.getEast() - tileOrigin.lng) / tileLon);

		return new L.Bounds(
			[Math.max(W, 0), Math.max(N, 0)],
			[Math.min(E, Math.pow(2, tileZoom) - 1), Math.min(S, Math.pow(2, tileZoom) - 1)]
		);
	},

	_isValidTile: function (coords) {
		return true;
	},
	
	_getTileLatLng: function (coords) {
		var tileBounds = this.options.bounds,
			tileOrigin = tileBounds.getNorthWest(),
			zoom = coords.ez,
			tileLat = this._tileBoundsLat / Math.pow(2, zoom),
			tileLon = this._tileBoundsLon / Math.pow(2, zoom);

		return new L.latLng(
			tileOrigin.lat - tileLat * coords.y,
			tileOrigin.lng + tileLon * coords.x
		);
	},
	
	_getTilePos: function (coords) {
		var latlon = this._getTileLatLng(coords);
		return this._map.project(latlon, coords.z).round().subtract(this._level.origin);
	},
	
	_getTileSizeCoords: function (coords) {
		var nw = this._getTilePos(coords),
			se = this._getTilePos({
				x: coords.x + 1,
				y: coords.y + 1,
				z: coords.z,
				ez: coords.ez
			});

		return se.subtract(nw);
	},
	
	_setView: function (center, zoom, noPrune, noUpdate) {
		var tileZoom = Math.round(zoom);
		var tileZoomChanged = (tileZoom !== this._tileZoom);

		if (!noUpdate || tileZoomChanged) {

			this._tileZoom = tileZoom;
			this.tileZoom = this._getTileZoom(tileZoom);

			if (this._abortLoading) {
				this._abortLoading();
			}

			this._updateLevels();

			if (tileZoom !== undefined) {
				this._update(center);
			}

			if (!noPrune) {
				this._pruneTiles();
			}

			// Flag to prevent _updateOpacity from pruning tiles during
			// a zoom anim or a pinch gesture
			this._noPrune = !!noPrune;
		}

		this._setZoomTransforms(center, zoom);
	},
	

	// Private method to load tiles in the grid's active zoom level according to map bounds
	_update: function (center) {
		var map = this._map;
		if (!map) { return; }
		var zoom = map.getZoom();

		if (center === undefined) { center = map.getCenter(); }
		if (this._tileZoom === undefined) { return; }	// if out of minzoom/maxzoom

		var tileZoom = this._getTileZoom(zoom),
			tileImageZoom = this._getTileImageZoom(tileZoom),
			tileImageScale = Math.pow(2, tileZoom - tileImageZoom),
			tileRange = this._getTileRange(map.getBounds(), tileZoom),
		    tileCenter = tileRange.getCenter(),
		    queue = [];

		for (var key in this._tiles) {
			this._tiles[key].current = false;
		}

		// _update just loads more tiles. If the tile zoom level differs too much
		// from the map's, let _setView reset levels and prune old tiles.
		if (Math.abs(zoom - this._tileZoom) > 1) { this._setView(center, zoom); return; }

		// create a queue of coordinates to load tiles from
		for (var j = tileRange.min.y; j <= tileRange.max.y; j++) {
			for (var i = tileRange.min.x; i <= tileRange.max.x; i++) {
				var coords = new L.Point(i, j);
				coords.z = zoom;
				coords.ez = tileZoom;
				coords.iz = tileImageZoom;
				coords.ix = Math.floor(i / tileImageScale);
				coords.iy = Math.floor(j / tileImageScale);

				var tile = this._tiles[this._tileCoordsToKey(coords)];
				if (tile) {
					tile.current = true;
				} else {
					queue.push(coords);
				}
			}
		}

		// sort tile queue to load tiles in order of their distance to center
		queue.sort(function (a, b) {
			return a.distanceTo(tileCenter) - b.distanceTo(tileCenter);
		});

		if (queue.length !== 0) {
			// if its the first batch of tiles to load
			if (!this._loading) {
				this._loading = true;
				// @event loading: Event
				// Fired when the grid layer starts loading tiles
				this.fire('loading');
			}

			// create DOM fragment to append tiles in one batch
			var fragment = document.createDocumentFragment();

			for (i = 0; i < queue.length; i++) {
				this._addTile(queue[i], fragment);
			}

			this._level.el.appendChild(fragment);
		}
	},
	
	_addTile: function (coords, container) {
		var tilePos = this._getTilePos(coords),
		    key = this._tileCoordsToKey(coords);

		var tile = this.createTile(coords, L.bind(this._tileReady, this, coords));

		this._initTile(tile);
		
		// reset tile width, height
		var tileSize = this._getTileSizeCoords(coords);
		tile.style.width = tileSize.x + 'px';
		tile.style.height = tileSize.y + 'px';

		// if createTile is defined with a second argument ("done" callback),
		// we know that tile is async and will be ready later; otherwise
		if (this.createTile.length < 2) {
			// mark tile as ready, but delay one frame for opacity animation to happen
			L.Util.requestAnimFrame(L.bind(this._tileReady, this, coords, null, tile));
		}

		L.DomUtil.setPosition(tile, tilePos);

		// save tile in cache
		this._tiles[key] = {
			el: tile,
			coords: coords,
			current: true
		};

		container.appendChild(tile);
		// @event tileloadstart: TileEvent
		// Fired when a tile is requested and starts loading.
		this.fire('tileloadstart', {
			tile: tile,
			coords: coords
		});
	},
	
	createTile: function (coords, done) {
			
		return this.createCanvasTileOverscaled(coords, done);

		if (L.Browser.edge){
			return this.createCanvasTile(coords, done);
		}else{
			return this.createImageTile(coords, done);
		}
	},

	createImageTile: function (coords, done) {
		var tile = document.createElement('img');

		L.DomEvent.on(tile, 'load', L.bind(this._tileOnLoad, this, done, tile));
		L.DomEvent.on(tile, 'error', L.bind(this._tileOnError, this, done, tile));

		tile.alt = '';
		tile.src = this.getTileUrl(coords);
		
		// image-rendering
		tile.style.msInterpolationMode = 'nearest-neighbor';
		tile.style.imageRendering = '-webkit-crisp-edges';
		tile.style.imageRendering = '-moz-crisp-edges';
		tile.style.imageRendering = 'pixelated';

		if (this._disable3DImageRendering) {
			tile.style.willChange = 'initial';
		}

		return tile;
	},
	
	createCanvasTile: function (coords, done) {
		var tile = L.DomUtil.create('canvas', 'leaflet-tile');

		tile.width = 320;
		tile.height = 420;

		var ctx = tile.getContext('2d');

		// pixcelated scaling
		ctx.mozImageSmoothingEnabled = false;
		ctx.webkitImageSmoothingEnabled = false;
		ctx.msImageSmoothingEnabled = false;
		ctx.imageSmoothingEnabled = false;

		var img = new Image();
		img.src = this.getTileUrl(coords);
		img.onload = function () {
			ctx.drawImage(img, 0, 0);
			done(null, tile);
		};

		return tile;
	},
	
	createCanvasTileOverscaled: function (coords, done) {
		var tile = L.DomUtil.create('canvas', 'leaflet-tile');

		var tileSize = this._getTileSizeCoords(coords);
		tile.width = tileSize.x;
		tile.height = tileSize.y;

		var sw = 320,
			sh = 420;

		var ctx = tile.getContext('2d');
		var map = this;

		// pixcelated scaling
		ctx.mozImageSmoothingEnabled = false;
		ctx.webkitImageSmoothingEnabled = false;
		ctx.msImageSmoothingEnabled = false;
		ctx.imageSmoothingEnabled = false;

		var img = new Image();
		img.src = this.getTileUrl(coords);
		img.onload = function () {
			var tileLat = map._tileBoundsLat / Math.pow(2, coords.ez),
				tileLon = map._tileBoundsLon / Math.pow(2, coords.ez),
				tilePos = map._getTileLatLng(coords);

			var sTileLat = map._tileBoundsLat / Math.pow(2, coords.iz),
				sTileLon = map._tileBoundsLon / Math.pow(2, coords.iz),
				sTilePos = map._getTileLatLng({x: coords.ix, y: coords.iy, ez: coords.iz});

			var sp1 = new L.Point(
				Math.floor((tilePos.lng - sTilePos.lng) / (sTileLon / sw)),
				Math.floor((sTilePos.lat - tilePos.lat) / (sTileLat / sh))
			);
			var sp2 = new L.Point(
				Math.ceil(((tilePos.lng + tileLon) - sTilePos.lng) / (sTileLon / sw)),
				Math.ceil((sTilePos.lat - (tilePos.lat - tileLat)) / (sTileLat / sh))
			);

			var dpbase = map._map.project(tilePos, coords.z),
				dpbase2x = dpbase.x + tile.width,
				dpbase2y = dpbase.y + tile.height,
				dpy = dpbase.y,
				lon3 = sTilePos.lng + sTileLon / sw * (sp1.x + 1),
				lon4 = sTilePos.lng + sTileLon / sw * (sp2.x - 1),
				dp3x = map._map.project([0, lon3], coords.z).x,
				dp4x = map._map.project([0, lon4], coords.z).x;

			var sx1 = sp1.x,
				sx2 = sp1.x + 1,
				sx3 = sp2.x - 1,
				sw2 = (sp2.x - 1) - (sp1.x + 1),
				dx2 = dp3x - dpbase.x,
				dx3 = dp4x - dpbase.x,
				dw1 = dp3x - dpbase.x,
				dw2 = dp4x - dp3x,
				dw3 = dpbase2x - dp4x;

			var lon1 = sTilePos.lng + sTileLon / sw * (sp1.x + 1),
				lon2 = sTilePos.lng + sTileLon / sw * (sp2.x - 1),
				check_p1 = (lon1 != tilePos.lng),
				check_p2 = (lon2 != tilePos.lng + tileLon);

				var l1 = sTilePos.lat - (sp2.y) * (sTileLat / sh);
				console.log([coords.y, map._map.project([l1, 0], coords.z).y, dpbase2y]);
			for (var sy = sp1.y; sy < sp2.y; sy++){
				var l = sTilePos.lat - (sy + 1) * (sTileLat / sh);
				var y = Math.min(map._map.project([l, 0], coords.z).y, dpbase2y);
				var dy = dpy - dpbase.y;
				var dh = y - dpy
				dpy = y;

				if (check_p1) ctx.drawImage(img, sx1, sy,   1, 1,   0, dy, dw1, dh);
				ctx.drawImage(img, sx2, sy, sw2, 1, dx2, dy, dw2, dh);
				if (check_p2) ctx.drawImage(img, sx3, sy,   1, 1, dx3, dy, dw3, dh);
			}
			done(null, tile);
		};

		return tile;
	},
});


L.equirectangularTile = function () {
	return new L.EquirectangularTile();
};
