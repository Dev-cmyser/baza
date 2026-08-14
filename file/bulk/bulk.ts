namespace $ {

	/**
	 * Файл с крупными кусками и метаданными размера.
	 *
	 * Отличий от обычного файла два.
	 *
	 * Куски крупнее: обычный файл режет по 32 КБ, здесь для крупных файлов
	 * берётся почти весь допустимый размер юнита. Это вдвое меньше юнитов,
	 * подписей и записей в хранилище на тот же объём. Больше нельзя: формат
	 * sand-юнита не принимает данные от 64 КБ, причём и для внешних балов
	 * тоже — `make` и `length_ball` кидают `Size too large`.
	 *
	 * Размер хранится отдельным полем: обычный файл считает его сложением
	 * длин всех кусков, а значит поднимает из хранилища всё содержимое даже
	 * когда нужен только размер.
	 */
	export class $giper_baza_file_bulk extends $giper_baza_dict.with( {
		/** Имя файла */
		Name: $giper_baza_atom_text,
		/** Content-Type */
		Type: $giper_baza_atom_text,
		/** Полный размер в байтах, чтобы не поднимать куски ради него */
		Size: $giper_baza_atom_int,
		/** Каким размером куска файл нарезан: без него не собрать обратно */
		Grain: $giper_baza_atom_int,
		/** Содержимое кусками */
		Chunks: $giper_baza_list_bin,
	}) {

		/** Кусок для мелких файлов — как в обычном файле. */
		static grain_small = 2 ** 15

		/**
		 * Кусок для крупных файлов. Предел формата — 65535 байт, берём с
		 * запасом на служебные поля юнита и кратно восьми.
		 */
		static grain_large = 2 ** 16 - 2 ** 10

		/** С этого размера файл считается крупным. */
		static bulk_from = 2 ** 20

		static grain_for( size: number ) {
			return size >= this.bulk_from ? this.grain_large : this.grain_small
		}

		/** Постоянная ссылка на содержимое */
		uri() {
			return `?BAZA:file=${ this.link() };name=${ this.name() }`
		}

		name( next?: string | null ) {
			const ext = {
				'text/plain': 'txt',
				'application/json': 'json',
			}[ this.type() ] ?? 'bin'
			return this.Name( next )?.val( next ) ?? `${ this.link() }.${ ext }`
		}

		type( next?: string | null ) {
			return this.Type( next )?.val( next ) ?? 'application/octet-stream'
		}

		/** Размер содержимого. Читается из метаданных, куски не поднимаются. */
		size( next?: number ) {
			const val = this.Size( next === undefined ? undefined : BigInt( next ) )
				?.val( next === undefined ? undefined : BigInt( next ) )
			return Number( val ?? 0n )
		}

		/** Размер куска, которым нарезано содержимое. */
		grain( next?: number ) {
			const val = this.Grain( next === undefined ? undefined : BigInt( next ) )
				?.val( next === undefined ? undefined : BigInt( next ) )
			return Number( val ?? 0n ) || $giper_baza_file_bulk.grain_small
		}

		/** Сколько кусков занимает содержимое — без их чтения. */
		grains() {
			const size = this.size()
			return size ? Math.ceil( size / this.grain() ) : 0
		}

		/** Есть ли содержимое. Не поднимает куски из хранилища. */
		filled() {
			return this.size() > 0
		}

		blob( next?: $mol_blob ): $mol_blob {

			if( !next ) return new $mol_blob( this.chunks(), { type: this.type() } )

			const buffer = new Uint8Array( $mol_wire_sync( next ).arrayBuffer() )

			this.buffer( buffer )
			this.type( next.type )
			if( next instanceof $mol_dom_context.File ) this.name( next.name )

			return next
		}

		buffer( next?: Uint8Array< ArrayBuffer > ) {

			if( next ) {

				const grain = $giper_baza_file_bulk.grain_for( next.byteLength )
				const chunks = [] as Uint8Array< ArrayBuffer >[]

				for( let offset = 0; offset < next.byteLength; ) {
					chunks.push( next.slice( offset, offset += grain ) )
				}

				this.chunks( chunks )
				this.grain( grain )
				this.size( next.byteLength )

				return next

			} else {

				const chunks = this.chunks()
				const size = chunks.reduce( ( sum, chunk )=> sum + chunk.byteLength, 0 )
				const res = new Uint8Array( size )

				let offset = 0
				for( const chunk of chunks ) {
					res.set( chunk, offset )
					offset += chunk.byteLength
				}

				return res

			}

		}

		chunks( next?: readonly Uint8Array< ArrayBuffer >[] ) {
			return ( this.Chunks( next )?.items( next )?.filter( $mol_guard_defined ) ?? [] ) as Uint8Array< ArrayBuffer >[]
		}

		str( next?: string, type = 'text/plain' ) {
			if( next === undefined ) return $mol_charset_decode( this.buffer() )
			this.buffer( $mol_charset_encode( next ) )
			this.type( type )
			return next
		}

	}

}
