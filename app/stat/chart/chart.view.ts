namespace $.$$ {
	export class $giper_baza_app_stat_chart extends $.$giper_baza_app_stat_chart {
		
		@ $mol_mem
		times() {
			const times = [] as string[]
			for( let i = 1; i < 59; ++i ) times.push( `${i} secs ago` )
			for( let i = 1; i < 59; ++i ) times.push( `${i} mins ago` )
			for( let i = 1; i < 23; ++i ) times.push( `${i} hours ago` )
			for( let i = 1; i < 31; ++i ) times.push( `${i} days ago` )
			for( let i = 1; i < 12; ++i ) times.push( `${i} months ago` )
			return times
		}
		
		@ $mol_mem
		zones_x() {
			return [ 58, 116, 138, 168 ].flatMap( x => [ x, x ] )
		}
		
		@ $mol_mem
		zones_y() {
			let max = 0
			for( const metric of this.metrics() ) for( const y of metric.series_y() ) if( y > max ) max = y
			return Array.from( { length: 2 }, _=> [ 0, max, max, 0 ] ).flatMap( x => x )
		}
		
	}
}
