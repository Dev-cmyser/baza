namespace $ {

	/** One observed read: `t` - moment the value was sent (embedded in the value itself),
	  * `land` - which Land it came from, `lat` - end-to-end latency in ms (`Date.now() - t` at observation time). */
	export type $giper_bench_sample = {
		readonly t: number,
		readonly land: string,
		readonly lat: number,
	}

	/** Open-loop load generator for Giper Baza.
	  *
	  * Unlike the older closed-loop benchmark in giper/baza/bench (where: next op waits for previous to finish, which hides
	  * real latency under load - "coordinated omission"), this one sends by a fixed schedule:
	  * op `i` is due at `t0 + i * 1000 / rate`, no matter whether earlier ops have landed yet.
	  * Latency is measured end-to-end through the value itself: the writer stores `Date.now()`,
	  * a separate reader isolate (own Yard/Mine/socket, so it's a real round trip through the
	  * Master, not a local cache hit) computes `Date.now() - val()` on every change it notices. */
	export class $giper_bench extends $mol_object2 {

		static master() {
			return $mol_state_arg.value( 'master' ) || $mol_fail( new Error( 'Argument "master" is required' ) )
		}

		static role() {
			return ( $mol_state_arg.value( 'role' ) || 'both' ) as 'writer' | 'reader' | 'both'
		}

		@ $mol_memo.method
		static rate() {
			return Number( $mol_state_arg.value( 'rate' ) ) || 50
		}

		@ $mol_memo.method
		static duration() {
			return Number( $mol_state_arg.value( 'duration' ) ) || 60
		}

		@ $mol_memo.method
		static readers() {
			return Number( $mol_state_arg.value( 'readers' ) ) || 1
		}

		@ $mol_memo.method
		static lands() {
			return Number( $mol_state_arg.value( 'lands' ) ) || 1
		}

		static land() {
			return $mol_state_arg.value( 'land' ) || null
		}

		static out() {
			return $mol_state_arg.value( 'out' ) || null
		}

		/** Extra time to keep readers polling after the writers stop, to catch tail latency. */
		static drain() {
			return 1000
		}

		/** Isolated `$`-context with its own Yard/Mine/Auth, wired to given Master.
		  * Copy of the isolate helper from the older benchmark - same fixed Auth key, so every isolate
		  * (writer and readers alike) shares one identity and thus one Home Land,
		  * while each still gets its own socket/storage, forcing a real network round trip. */
		/**
		 * Ключ, общий для всех изолятов прогона: одна личность — один Home Land,
		 * и читателям не нужно передавать ссылку на ленд писателя.
		 *
		 * Хардкодить его, как делает старый бенчмарк, больше нельзя: формат
		 * ключа вырос до 128 байт, и на коротком ключе подпись юнитов падает
		 * с «Invalid typed array length». Поэтому ключ либо приходит аргументом
		 * `auth=`, либо генерируется на старте — это Proof of Work, секунды.
		 */
		static auth_str = ''

		static async auth_setup() {

			const given = $mol_state_arg.value( 'auth' )
			if( given ) {
				this.auth_str = given
				return
			}

			const $ = $$.$mol_ambient({})
			$.$giper_baza_mine = $giper_baza_mine_temp

			const auth = await $mol_wire_async( $.$giper_baza_auth ).grab() as $giper_baza_auth
			this.auth_str = auth.toString() + auth.toStringPrivate()

		}

		static isolate_count = 0
		static isolate( master?: string ) {

			const $ = $$.$mol_ambient({})
			const isolate_count = ++ this.isolate_count

			$.$giper_baza_mine = $giper_baza_mine_temp

			class $giper_bench_yard extends $giper_baza_yard {}
			$giper_bench_yard.masters = $mol_const( $mol_maybe( master ) )
			$.$giper_baza_yard = $giper_bench_yard

			class $giper_bench_glob extends $giper_baza_glob {
				static [ Symbol.toStringTag ] = '$giper_bench_glob' + ( isolate_count )
				static $ = $
				static lands_touched = new $mol_wire_set< string >()
			}
			$.$giper_baza_glob = $giper_bench_glob

			class $giper_bench_auth extends $giper_baza_auth {

				@ $mol_mem
				static override current() {
					return this.from( $giper_bench.auth_str )
				}

			}
			$.$giper_baza_auth = $giper_bench_auth

			return $
		}

		/** Wait until Yard opens a socket to its Master. Mirrors the connect step of the older benchmark. */
		static async connect( glob: typeof $giper_baza_glob, name: string ) {
			const atom = new $mol_wire_atom( name, ()=> {
				$mol_wire_solid()
				return glob.yard().master()!
			} )
			return atom.async()
		}

		/** `atom_real` Pawn at Land's data root, addressed by explicit Link string. */
		static land_pawn( glob: typeof $giper_baza_glob, land: string ) {
			return glob.Land( new $giper_baza_link( land ) ).Data( $giper_baza_flex_subj ).cast( $giper_baza_atom_real )
		}

		/** Land Link(s) writers will target:
		  * - `lands` > 1 - "office" scenario, grab that many fresh Lands (needs a fiber - PoW inside);
		  * - explicit `land` arg - write into an already existing Land;
		  * - otherwise - own Home Land, same as the older benchmark. */
		static async lands_setup( glob: typeof $giper_baza_glob ): Promise< readonly string[] > {

			if( this.lands() > 1 ) {
				const links: string[] = []
				for( let i = 0; i < this.lands(); ++i ) {
					const land = await $mol_wire_async( glob ).land_grab()
					links.push( land.link().str )
				}
				return links
			}

			if( this.land() ) return [ this.land()! ]

			return [ glob.home().link().str ]

		}

		/** Open-loop write schedule for a single Land: op `i` is sent at `t0 + i * 1000 / rate`
		  * regardless of whether the previous write has actually landed - that's the whole point,
		  * a busy Master shows up as growing `Date.now() - due` baked right into the stored value. */
		static async write_schedule(
			glob: typeof $giper_baza_glob,
			land: string,
			t0: number,
			sent: Map< string, number >,
		) {

			const pawn = this.land_pawn( glob, land )
			const rate = this.rate()
			const total = Math.max( 1, Math.round( rate * this.duration() ) )

			let count = 0

			for( let i = 0; i < total; ++i ) {

				const due = t0 + i * 1000 / rate
				const delay = due - Date.now()
				if( delay > 0 ) await this.$.$mol_wait_timeout_async( delay )

				try {
					// `$giper_baza_mine_temp` is fully synchronous, so a bare `.val()` is safe here -
					// same as the plain write in the older benchmark, no fiber wrapping needed.
					pawn.val( Date.now() )
				} catch( error ) {
					$mol_fail_log( error )
				}

				++count

			}

			sent.set( land, ( sent.get( land ) ?? 0 ) + count )

		}

		/** Polls a Land's value once a millisecond and records a sample on every change.
		  * This is a plain poll, not a reactive subscription (see `$mol_wire_atom` note in the task) -
		  * simpler and, for a single overwritten register, just as reliable: any gap between
		  * `sent` and `received` in the final report is real loss/coalescing under the schedule,
		  * not an artifact of how we watch it. */
		static async read_poll(
			glob: typeof $giper_baza_glob,
			land: string,
			until: number,
			samples: $giper_bench_sample[],
		) {

			const pawn = this.land_pawn( glob, land )
			let last: number | null = null

			while( Date.now() < until ) {

				const val = pawn.val()

				if( val !== null && val !== last ) {
					samples.push({ t: val, land, lat: Date.now() - val })
					last = val
				}

				await this.$.$mol_wait_timeout_async( 1 )

			}

		}

		/**
		 * Локальный замер без сети: сколько стоит одна запись на устройстве
		 * пользователя и деградирует ли она по мере роста истории ленда.
		 *
		 * Нужен, потому что сетевой прогон упирается в генератор раньше, чем в
		 * узел: на высоких ступенях узел простаивает, а до него доезжает всё
		 * меньше. Пока цена локальной записи неизвестна, потолок узла измерить
		 * нельзя — непонятно, чей потолок мы видим.
		 */
		static async run_local() {

			const count = Math.max( 1, Math.round( this.rate() * this.duration() ) )

			this.print_pair( 'Role', 'local (без сети)' )
			this.print_pair( 'Ops', count )

			await this.auth_setup()

			// Имя переменной без $-префикса: MAM парсит $-идентификаторы регэкспом
			// и принял бы `$w` за модуль `w/w`, уронив сборку.
			const ctx = this.isolate()
			const pawn = ctx.$giper_baza_glob.home().cast( $giper_baza_atom_real )

			const durs = [] as number[]

			for( let i = 1; i <= count; ++i ) {
				const start = Date.now()
				pawn.val( i )
				durs.push( Date.now() - start )
			}

			const sorted = [ ... durs ].sort( ( a, b )=> a - b )
			const total = durs.reduce( ( sum, d )=> sum + d, 0 )

			// Деградацию ищем сравнением первой и последней десятой доли прогона:
			// если запись дорожает с ростом накопленной истории, это видно сразу.
			const tenth = Math.max( 1, Math.floor( count / 10 ) )
			const avg = ( from: number, to: number )=> {
				let sum = 0
				for( let i = from; i < to; ++i ) sum += durs[ i ]
				return sum / ( to - from )
			}

			console.log()
			this.print_table( 'Local', 'Ops', 'ms/op', 'p50', 'p95', 'p99', 'Max', $mol_term_color.gray )
			this.print_table(
				'write',
				count,
				( total / count ).toFixed( 2 ),
				this.fmt( this.percentile( sorted, 50 ) ),
				this.fmt( this.percentile( sorted, 95 ) ),
				this.fmt( this.percentile( sorted, 99 ) ),
				this.fmt( sorted[ sorted.length - 1 ] ),
			)

			this.print_pair( 'First 10%', avg( 0, tenth ).toFixed( 2 ) + ' мс/оп' )
			this.print_pair( 'Last 10%', avg( count - tenth, count ).toFixed( 2 ) + ' мс/оп' )
			this.print_pair( 'Throughput', Math.round( 1000 * count / Math.max( 1, total ) ) + ' оп/с' )

			if( this.out() ) {
				$mol_file.absolute( this.out()! ).text(
					durs.map( ( d, i )=> JSON.stringify({ op: i + 1, ms: d }) ).join( '\n' ) + '\n'
				)
			}

			process.exit()

		}

		/**
		 * Локальный замер на упорядоченной коллекции — сценарий рисования:
		 * каждая чёрточка добавляет элемент, и каждое добавление прогоняет
		 * очередь юнитов через sand_ordered (pawn.units_of).
		 *
		 * Атомный замер этот путь не задевает: у атома очередь всегда из одного
		 * юнита, поэтому оптимизации sand_ordered на нём и не видны.
		 */
		static async run_list() {

			const count = Math.max( 1, Math.round( this.rate() * this.duration() ) )

			this.print_pair( 'Role', 'list (без сети)' )
			this.print_pair( 'Items', count )

			await this.auth_setup()

			const ctx = this.isolate()
			const list = ctx.$giper_baza_glob.home().cast( $giper_baza_list_str )

			const durs = [] as number[]

			for( let i = 1; i <= count; ++i ) {
				const start = Date.now()
				list.add( 'p' + i )
				durs.push( Date.now() - start )
			}

			const sorted = [ ... durs ].sort( ( a, b )=> a - b )
			const total = durs.reduce( ( sum, d )=> sum + d, 0 )
			const tenth = Math.max( 1, Math.floor( count / 10 ) )
			const avg = ( from: number, to: number )=> {
				let sum = 0
				for( let i = from; i < to; ++i ) sum += durs[ i ]
				return sum / ( to - from )
			}

			console.log()
			this.print_table( 'List', 'Items', 'ms/op', 'p50', 'p95', 'p99', 'Max', $mol_term_color.gray )
			this.print_table(
				'add',
				count,
				( total / count ).toFixed( 2 ),
				this.fmt( this.percentile( sorted, 50 ) ),
				this.fmt( this.percentile( sorted, 95 ) ),
				this.fmt( this.percentile( sorted, 99 ) ),
				this.fmt( sorted[ sorted.length - 1 ] ),
			)
			this.print_pair( 'First 10%', avg( 0, tenth ).toFixed( 2 ) + ' мс/оп' )
			this.print_pair( 'Last 10%', avg( count - tenth, count ).toFixed( 2 ) + ' мс/оп' )
			this.print_pair( 'Total', total + ' мс' )

			process.exit()

		}

		static async run() {

			if( this.role() as string === 'list' ) return this.run_list()
			if( this.role() as string === 'local' ) return this.run_local()

			this.print_pair( 'Master', this.master() )
			this.print_pair( 'Role', this.role() )
			this.print_pair( 'Rate', this.rate() + ' op/s' )
			this.print_pair( 'Duration', this.duration() + ' s' )
			this.print_pair( 'Readers', this.readers() )
			this.print_pair( 'Lands', this.lands() )

			await this.auth_setup()
			// Ключ печатается целиком: только так можно запустить писателя и
			// читателя разными процессами в одном ленде, а без этого нельзя
			// отличить настоящий сетевой round trip от обмена внутри процесса.
			this.print_pair( 'Auth', this.auth_str )

			const sent = new Map< string, number >()
			const samples: $giper_bench_sample[] = []

			const writer = ( this.role() !== 'reader' ) ? this.isolate( this.master() ) : null

			let links: readonly string[]

			if( writer ) {
				await this.connect( writer.$giper_baza_glob, 'connect_writer' )
				links = await this.lands_setup( writer.$giper_baza_glob )
			} else {
				if( this.lands() > 1 ) {
					console.log( $mol_term_color.yellow(
						'Warning: role=reader can\'t grab new Lands on its own, ignoring "lands" > 1'
					) )
				}
				const info = this.isolate()
				links = [ this.land() ?? info.$giper_baza_auth.current().pass().lord().str ]
			}

			this.print_pair( 'Land(s)', links.join( ', ' ) )
			if( this.readers() > 1 ) this.print_pair( 'Note', 'Recv is summed over all Readers of a Land' )

			const t0 = Date.now()
			const t_write_end = t0 + this.duration() * 1000
			const t_read_end = t_write_end + this.drain()

			const tasks: Promise< unknown >[] = []

			if( writer ) {
				for( const land of links ) {
					tasks.push( this.write_schedule( writer.$giper_baza_glob, land, t0, sent ) )
				}
			}

			if( this.role() !== 'writer' ) {
				for( let r = 0; r < this.readers(); ++r ) {
					tasks.push( ( async ()=> {
						const reader = this.isolate( this.master() )
						await this.connect( reader.$giper_baza_glob, `connect_reader${ r }` )
						await Promise.all(
							links.map( land => this.read_poll( reader.$giper_baza_glob, land, t_read_end, samples ) )
						)
					} )() )
				}
			}

			await Promise.all( tasks )

			this.print_table( 'Land', 'Sent', 'Recv', 'p50', 'p95', 'p99', 'Max', $mol_term_color.gray )

			for( const land of links ) {
				const lat = samples.filter( s => s.land === land ).map( s => s.lat )
				const st = this.stats( lat )
				this.print_table(
					land.length > 10 ? land.slice( 0, 10 ) + '…' : land,
					sent.get( land ) ?? 0, lat.length,
					this.fmt( st.p50 ), this.fmt( st.p95 ), this.fmt( st.p99 ), this.fmt( st.max ),
				)
			}

			if( links.length > 1 ) {
				const lat_all = samples.map( s => s.lat )
				const st_all = this.stats( lat_all )
				const sent_all = [ ... sent.values() ].reduce( ( a, b )=> a + b, 0 )
				this.print_table(
					'ALL', sent_all, lat_all.length,
					this.fmt( st_all.p50 ), this.fmt( st_all.p95 ), this.fmt( st_all.p99 ), this.fmt( st_all.max ),
					$mol_term_color.yellow,
				)
			}

			if( this.out() ) {
				const content = samples.map( s => JSON.stringify( s ) ).join( '\n' ) + '\n'
				$mol_file.absolute( this.out()! ).text( content )
				this.print_pair( 'Out', this.out() )
			}

			process.exit()

		}

		/** p50/p95/p99/max of a latency array (nearest-rank percentile). */
		static stats( samples: readonly number[] ) {
			const sorted = [ ... samples ].sort( ( a, b )=> a - b )
			return {
				p50: this.percentile( sorted, 50 ),
				p95: this.percentile( sorted, 95 ),
				p99: this.percentile( sorted, 99 ),
				max: sorted.length ? sorted[ sorted.length - 1 ] : NaN,
			}
		}

		static percentile( sorted: readonly number[], p: number ) {
			if( !sorted.length ) return NaN
			const idx = Math.min( sorted.length - 1, Math.floor( p / 100 * sorted.length ) )
			return sorted[ idx ]
		}

		static fmt( n: number ) {
			return Number.isFinite( n ) ? String( Math.round( n ) ) : '-'
		}

		static print_pair( name: any, value: any ) {
			console.log(
				$mol_term_color.cyan( String( name ).padEnd( 12 ) ),
				$mol_term_color.yellow( String( value ) ),
			)
		}

		static print_table(
			name: any, sent: any, recv: any, p50: any, p95: any, p99: any, max: any,
			color: typeof $mol_term_color.gray = $mol_term_color.cyan,
		) {
			console.log(
				color( String( name ).padEnd( 12 ) ),
				color( String( sent ).padStart( 8 ) ),
				color( String( recv ).padStart( 8 ) ),
				color( String( p50 ).padStart( 6 ) ),
				color( String( p95 ).padStart( 6 ) ),
				color( String( p99 ).padStart( 6 ) ),
				color( String( max ).padStart( 6 ) ),
			)
		}

	}

	$giper_bench.run().catch( error => {
		console.error( error )
		process.exit( 1 )
	} )

}
