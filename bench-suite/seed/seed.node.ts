namespace $ {

	/** Builds a private Giper Baza Seed+Deck bootstrap (a `.baza` pack) that lists only the given
	  * Peers, so a node booting from it never learns about the public master. Companion tool for
	  * giper/BENCHMARK_PLAN.md section 4 ("свой Seed на два пира") - Stage 2, two nodes, S10-S12. */
	export class $giper_seed extends $mol_object2 {

		static out() {
			return $mol_state_arg.value( 'out' ) || $mol_fail( new Error( 'Argument "out" is required' ) )
		}

		/** Peer URLs, two ways to list them: numbered `peer1=.. peer2=..` (contiguous from 1),
		  * and/or one `peers=url1,url2,..`. Either alone is enough; both are merged if given. */
		static peer_urls() {

			const list: string[] = []

			const csv = $mol_state_arg.value( 'peers' )
			if( csv ) list.push( ... csv.split( ',' ).map( s => s.trim() ).filter( Boolean ) )

			for( let i = 1; ; ++i ) {
				const url = $mol_state_arg.value( 'peer' + i )
				if( !url ) break
				list.push( url )
			}

			if( !list.length ) $mol_fail( new Error(
				'No peers given: pass peer1=.. peer2=.. (contiguous from 1) or peers=url1,url2'
			) )

			return list
		}

		/** Identity that signs the Seed/Deck/Peer units. Same gotcha as in the load generator next
		  * door (giper/bench): a hardcoded key fails Auth's `byteLength === 128` check, so it's
		  * generated fresh (PoW, a couple seconds) unless a previously generated one comes in via `auth=`. */
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

		/** Isolated `$`-context. No Master is configured, on purpose: shadowing `masters` with a
		  * constant replaces Yard's own `masters()`, which otherwise reads Seed() -> boot() -> tries
		  * to load a `web.baza` next to this very script and fails, since none is deployed here -
		  * this script only ever needs to build a Land locally and dump it, never to connect anywhere. */
		static isolate() {

			const $ = $$.$mol_ambient({})
			// `$giper_baza_flex_init` is a plain `this: $` function, not a class method, and reads
			// `this.$` inside its own body - the ambient doesn't self-reference by default, only
			// `$mol_object2` instances/subclasses do (via their own `.$` getter/static), so it has
			// to be wired up by hand here for a bare `this: $` call to work.
			$.$ = $

			$.$giper_baza_mine = $giper_baza_mine_temp

			class $giper_seed_yard extends $giper_baza_yard {}
			$giper_seed_yard.masters = $mol_const( [] as string[] )
			$.$giper_baza_yard = $giper_seed_yard

			class $giper_seed_glob extends $giper_baza_glob {
				static [ Symbol.toStringTag ] = '$giper_seed_glob'
				static $ = $
				static lands_touched = new $mol_wire_set< string >()

				/** Everything that touches crypto (Proof of Work in `flex_init`'s Land grab, then
				  * signing/encoding each written field) has to happen in ONE fiber. Splitting it across
				  * separate `await`s lets a wire-promise from the crypto layer escape uncaught - the
				  * retry-safety that makes suspend/resume work at all only covers nested calls made
				  * from inside a single running fiber, not separate top-level `$mol_wire_async` calls. */
				static build( peer_urls: readonly string[] ) {

					const seed = this.$.$giper_baza_flex_init() as $giper_baza_flex_seed

					const peers: { url: string, link: string }[] = []

					for( let i = 0; i < peer_urls.length; ++i ) {
						const peer = seed.Peers( null )!.make( $mol_hash_string( 'peer' + i ) )
						peer.name( peer_urls[ i ] )
						peer.urls([ peer_urls[ i ] ])
						peers.push({ url: peer_urls[ i ], link: peer.link().str })
					}

					// A Seed spans two Lands (its own, and a second one split off for the Deck) -
					// dump both, or `boot()` on the other end reconstructs a Deck-less Seed.
					const parts = [ ... this.lands_touched.values() ]
						.flatMap( id => this.Land( new $giper_baza_link( id ) ).diff_parts() )
					const pack = $giper_baza_pack.make( parts )

					return { seed, peers, pack }

				}

			}
			$.$giper_baza_glob = $giper_seed_glob

			class $giper_seed_auth extends $giper_baza_auth {

				@ $mol_mem
				static override current() {
					return this.from( $giper_seed.auth_str )
				}

			}
			$.$giper_baza_auth = $giper_seed_auth

			return $
		}

		static async run() {

			await this.auth_setup()

			const peer_urls = this.peer_urls()
			const $ = this.isolate()

			const { seed, peers, pack } = await $mol_wire_async( $.$giper_baza_glob ).build( peer_urls ) as {
				seed: $giper_baza_flex_seed,
				peers: { url: string, link: string }[],
				pack: $giper_baza_pack,
			}

			$mol_file.absolute( this.out() ).buffer( pack.asArray() )

			this.print_pair( 'Seed', seed.link().str )
			this.print_pair( 'Deck', seed.deck()!.link().str )
			for( const peer of peers ) this.print_pair( 'Peer', `${ peer.link } -> ${ peer.url }` )
			this.print_pair( 'Auth', $giper_seed.auth_str )
			this.print_pair( 'Out', this.out() )

			process.exit()

		}

		static print_pair( name: any, value: any ) {
			console.log(
				$mol_term_color.cyan( String( name ).padEnd( 8 ) ),
				$mol_term_color.yellow( String( value ) ),
			)
		}

	}

	$giper_seed.run().catch( error => {
		console.error( error )
		process.exit( 1 )
	} )

}
