import Ractive from 'ractive';
import BaseView from './BaseView';

Ractive.DEBUG = false;

new BaseView({ el: 'main' });

(function () {
	// if CSS transforms aren't supported, don't show the 'fork me' button.
	// Quick and dirty detect
	var style = document.createElement( 'div' ).style;

	if ( style.transform !== undefined ) {
		document.body.className += 'transforms-enabled';
	} else {
		[ 'webkit', 'moz', 'ms', 'o' ].forEach( function ( vendor ) {
			if ( style[ vendor + 'Transform' ] !== undefined ) {
				document.body.className += 'transforms-enabled';
			}
		});
	}
}());